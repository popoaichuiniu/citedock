import importlib.util
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "mlx_server", Path(__file__).resolve().parents[1] / "scripts/mlx_embedding_server.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Engine:
    max_tokens = 8192

    def __init__(self):
        self.calls = []

    def embed(self, texts):
        if texts == ["too long"]:
            raise ValueError("Too many tokens")
        self.calls.append(texts)
        return {"model": module.MODEL, "data": [
            {"index": i, "embedding": [1.0, 0.0]} for i, _ in enumerate(texts)]}


class MlxHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine()
        cls.server = HTTPServer(("127.0.0.1", 0), module.make_handler(cls.engine))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, body, path="/v1/embeddings", content_type="application/json"):
        request = urllib.request.Request(
            self.url + path, data=json.dumps(body).encode(),
            headers={"Content-Type": content_type}, method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_string_and_batch_keep_raw_text_and_order(self):
        for texts in ["plain document", ["Instruct: retrieve\nQuery: 向量", "文档"]]:
            status, body = self.request({"model": module.MODEL, "input": texts})
            self.assertEqual(status, 200)
            expected = [texts] if isinstance(texts, str) else texts
            self.assertEqual(self.engine.calls[-1], expected)
            self.assertEqual([row["index"] for row in body["data"]], list(range(len(expected))))

    def test_invalid_model_encoding_and_inputs_never_run_inference(self):
        before = len(self.engine.calls)
        for body in [
            {"model": "chat-model", "input": "doc"},
            {"model": module.MODEL, "input": "doc", "encoding_format": "base64"},
            {"model": module.MODEL, "input": [1, 2]},
            {"model": module.MODEL, "input": ["doc", " "]},
            {"model": module.MODEL, "input": []},
            {"model": module.MODEL, "input": "doc", "dimensions": 1024},
        ]:
            self.assertEqual(self.request(body)[0], 400)
        self.assertEqual(len(self.engine.calls), before)

    def test_long_input_content_type_and_path(self):
        self.assertEqual(self.request({"model": module.MODEL, "input": "too long"})[0], 400)
        self.assertEqual(self.request({}, content_type="text/plain")[0], 415)
        self.assertEqual(self.request({}, path="/v1/chat/completions")[0], 404)
        with urllib.request.urlopen(self.url + "/healthz", timeout=5) as response:
            body = json.load(response)
            self.assertEqual(body["revision"], module.REVISION)
            self.assertEqual(body["dimensions"], 4096)


if __name__ == "__main__":
    unittest.main()
