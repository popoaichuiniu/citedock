# Configuration

[Home](../README.md) · [中文完整指南](guide.zh-CN.md)

Copy `.env.example` to `.env` in the repository root. Configuration is loaded from that location even when MCP starts from another working directory. Existing environment variables take precedence.

## Local services

| Service          | Default address            | Start command                              |
| ---------------- | -------------------------- | ------------------------------------------ |
| Qdrant           | `http://127.0.0.1:6333`    | `npm run qdrant` or `docker compose up -d` |
| MLX embeddings   | `http://127.0.0.1:8000/v1` | `npm run mlx`                              |
| Web and HTTP API | `http://127.0.0.1:3000`    | `npm start` after building                 |

The MCP process accesses Qdrant and embeddings directly. It does not call the HTTP server.

The macOS Qdrant helper downloads the official v1.19.2 binary, verifies its SHA-256, and stores data in `storage/qdrant`. Docker uses the `qdrant_data` volume defined in [compose.yaml](../compose.yaml). Choose one deployment at a time for the default port.

## MLX on Apple Silicon

The default `.env.example` uses the OpenAI-compatible local MLX endpoint:

```dotenv
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=http://127.0.0.1:8000/v1
EMBEDDING_MODEL=mlx-community/Qwen3-Embedding-8B-4bit-DWQ
EMBEDDING_DIMENSIONS=4096
QDRANT_COLLECTION=rag_qwen3_8b_mlx
```

`npm run mlx` creates `.local/mlx-venv`, installs [pinned dependencies](../scripts/requirements-mlx.txt), and caches weights in `.local/huggingface`. Requirements are Python 3.11+, Apple Silicon, and macOS 26+ for these dependency versions. If needed, set `MLX_PYTHON=/absolute/path/to/python3`.

The default model revision is `885642d6b98742ea03b77a1673579c92ca961efd`. The service uses the last valid token's hidden state and float32 L2 normalization. It does not use chat templates or generated-token logits. Inputs run serially without padding.

The default limit is 8192 tokens per input. Oversized inputs return an error rather than being silently truncated. To allow up to the model's declared 32K context:

```bash
npm run mlx -- --max-tokens 32768
```

Long inputs require more memory. Wait for `MLX embeddings ready`; `GET http://127.0.0.1:8000/healthz` reports the loaded model, revision, dimensions, and token limit.

## Ollama

Start your local Ollama service, then download the 8B embedding model:

```bash
ollama pull qwen3-embedding:8b
```

Change `.env`:

```dotenv
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=qwen3-embedding:8b
EMBEDDING_DIMENSIONS=4096
QDRANT_COLLECTION=rag_qwen3_8b_ollama
```

Use a new collection even if the dimensions are unchanged: different weights or quantization can produce different vectors. Start Qdrant, rebuild if needed, restart CiteDock, and re-import your documents. Ollama is independent of the MLX helper.

## OpenAI-compatible services

Configure a service that implements `POST /embeddings` under its API base URL:

```dotenv
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://your-embedding-service.example/v1
EMBEDDING_MODEL=your-embedding-model-id
EMBEDDING_DIMENSIONS=4096
EMBEDDING_API_KEY=your-service-key
QDRANT_COLLECTION=your_new_collection
```

Set the actual output dimensions and embedding model ID. A chat-completion model is not an embedding model. The API key can be empty for a local endpoint that does not require authentication.

## Settings

| Variable               | Default                                                                 | Meaning                                                             |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `EMBEDDING_BATCH_SIZE` | `4`                                                                     | Inputs per embedding request                                        |
| `EMBEDDING_TIMEOUT_MS` | `180000`                                                                | Embedding request timeout                                           |
| `QUERY_INSTRUCTION`    | `Given a question, retrieve relevant passages that answer the question` | Instruction prepended to search queries                             |
| `QDRANT_URL`           | `http://127.0.0.1:6333`                                                 | Qdrant endpoint                                                     |
| `QDRANT_API_KEY`       | empty                                                                   | Qdrant API credential                                               |
| `QDRANT_COLLECTION`    | `rag_qwen3_8b_mlx`                                                      | Collection for this embedding configuration                         |
| `QDRANT_TIMEOUT_MS`    | `30000`                                                                 | Qdrant request timeout                                              |
| `QDRANT_KEEP_ALIVE`    | `true`                                                                  | Reuse Qdrant HTTP connections                                       |
| `CHUNK_SIZE`           | `1200`                                                                  | Target chunk length in Unicode code points                          |
| `CHUNK_OVERLAP`        | `150`                                                                   | Overlap in Unicode code points                                      |
| `HTTP_HOST`            | `127.0.0.1`                                                             | HTTP listen address                                                 |
| `HTTP_PORT`            | `3000`                                                                  | HTTP port                                                           |
| `RAG_API_KEY`          | empty                                                                   | Optional local HTTP bearer token; required for non-loopback binding |

Document chunks are not token-sized. Query instructions use `Instruct: ...\nQuery: ...`; document text is embedded without that query prefix.

CiteDock checks collection dimensions, cosine distance, and recorded model/provider metadata before using it. A reused model alias cannot reveal that its underlying weights changed. Always change the collection when changing embedding models, providers, or dimensions.

## Troubleshooting

- **MCP cannot start:** build first, use absolute paths to both Node and `dist/mcp.js`, and check the client's stderr log. Stdout is reserved for JSON-RPC.
- **Web opens but imports fail:** `/healthz` only checks the HTTP process. `/readyz` checks Qdrant and the embedding service. Wait for the model to finish loading.
- **HTTP 401:** send `Authorization: Bearer YOUR_RAG_API_KEY`. In the dashboard, enter the same key under connection settings; it is held in page memory and cleared on reload.
- **Collection mismatch:** select a new `QDRANT_COLLECTION` and re-import with the current embedding configuration.
- **PDF rejected:** scanned pages require OCR outside CiteDock; decrypt encrypted files before importing. Mixed text/scanned PDFs are rejected as a whole.
- **Qdrant connection reset while debugging:** set `QDRANT_KEEP_ALIVE=false`. The supplied VS Code launch configurations already do this for long breakpoint pauses.
- **Web TypeScript edits are missing:** rerun `npm run build`, or restart `npm run dev`, then refresh.

See [security](../SECURITY.md) before exposing the HTTP service beyond your machine. Namespaces organize documents; they are not user access controls.
