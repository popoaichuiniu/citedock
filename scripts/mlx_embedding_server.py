"""Local Qwen3 Embedding inference with Apple's MLX runtime.

The TypeScript service adds query instructions. This server embeds raw input,
using the final unpadded token's hidden state, never chat templates or LM logits.
"""

import argparse
import json
import math
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODEL = "mlx-community/Qwen3-Embedding-8B-4bit-DWQ"
REVISION = "885642d6b98742ea03b77a1673579c92ca961efd"
DIMENSIONS = 4096
MAX_BODY = 8 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


def parse_input(body):
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    if body.get("model") != MODEL:
        raise ValueError(f"model must be {MODEL}")
    if body.get("encoding_format", "float") != "float":
        raise ValueError("Only encoding_format=float is supported")
    if "dimensions" in body and body["dimensions"] != DIMENSIONS:
        raise ValueError("Server returns 4096 dimensions; resize in the client")
    texts = body.get("input")
    if isinstance(texts, str):
        texts = [texts]
    if not isinstance(texts, list) or not 1 <= len(texts) <= 128:
        raise ValueError("input must contain 1 to 128 strings")
    if any(not isinstance(text, str) or not text.strip() for text in texts):
        raise ValueError("input must contain non-empty strings, not token IDs")
    return texts


class QwenMlx:
    def __init__(self, model_path, max_tokens):
        import mlx.core as mx
        from mlx_lm import load

        if not mx.metal.is_available():
            raise RuntimeError("MLX requires an Apple Silicon Mac with Metal")
        self.mx = mx
        self.model, self.tokenizer = load(str(model_path))
        if self.model.args.model_type != "qwen3" or self.model.args.hidden_size != DIMENSIONS:
            raise RuntimeError("Expected the pinned Qwen3 8B checkpoint with hidden size 4096")
        self.max_tokens = max_tokens

    def embed(self, texts):
        # Validate the entire batch before inference; never silently truncate.
        tokens = [self.tokenizer.encode(text, add_special_tokens=True) for text in texts]
        if any(not ids or len(ids) > self.max_tokens for ids in tokens):
            raise ValueError(f"Each input must contain 1 to {self.max_tokens} tokens")
        mx = self.mx
        data = []
        try:
            for index, ids in enumerate(tokens):
                # One unpadded sequence at a time avoids padding entering causal attention.
                hidden = self.model.model(mx.array([ids]))
                vector = hidden[0, -1, :].astype(mx.float32)
                vector = vector / mx.linalg.norm(vector)
                values = vector.tolist()
                if not all(math.isfinite(value) for value in values):
                    raise RuntimeError("Model returned a non-finite embedding")
                data.append({"object": "embedding", "index": index, "embedding": values})
                del hidden, vector
        finally:
            mx.clear_cache()
        count = sum(len(ids) for ids in tokens)
        return {
            "object": "list",
            "model": MODEL,
            "data": data,
            "usage": {"prompt_tokens": count, "total_tokens": count},
        }


def make_handler(engine):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def reply(self, status, body):
            raw = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/healthz":
                self.reply(200, {"ok": True, "model": MODEL, "revision": REVISION,
                                 "dimensions": DIMENSIONS, "maxTokens": engine.max_tokens})
            else:
                self.reply(404, {"error": {"message": "Unknown endpoint"}})

        def do_POST(self):
            if self.path != "/v1/embeddings":
                self.reply(404, {"error": {"message": "Unknown endpoint"}})
                return
            try:
                if self.headers.get_content_type() != "application/json":
                    self.reply(415, {"error": {"message": "Use application/json"}})
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    self.reply(413, {"error": {"message": "Request must be 1 byte to 8 MiB"}})
                    return
                texts = parse_input(json.loads(self.rfile.read(length)))
                result = engine.embed(texts)
            except (ValueError, UnicodeDecodeError) as error:
                self.reply(400, {"error": {"message": str(error)}})
                return
            except Exception as error:
                self.log_error("Inference failed: %s", error)
                self.reply(500, {"error": {"message": "MLX inference failed; check server log"}})
                return
            self.reply(200, result)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-tokens", type=int, default=8192)
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.max_tokens <= 32768:
        parser.error("port must be 1..65535; max-tokens must be 1..32768")
    from huggingface_hub import snapshot_download

    path = snapshot_download(
        MODEL, revision=REVISION, cache_dir=ROOT / ".local" / "huggingface",
        allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja"],
    )
    print(f"Pinned model ready: {MODEL}@{REVISION}", flush=True)
    if args.download_only:
        return
    engine = QwenMlx(path, args.max_tokens)
    # Serialize GPU inference in the same thread. Public exposure is handled by the TS API.
    server = HTTPServer(("127.0.0.1", args.port), make_handler(engine))
    print(f"MLX embeddings ready: http://127.0.0.1:{args.port}/v1/embeddings", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
