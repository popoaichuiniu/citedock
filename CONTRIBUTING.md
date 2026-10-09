# Contributing to CiteDock

Thank you for helping improve local knowledge tools for AI agents.

## Getting started

Use Node.js 22.13+ and npm:

```bash
npm ci
npm run check
```

The standard test suite uses controlled dependencies; Qdrant and a downloaded model are not required. Some tests start loopback HTTP servers.

For the real application, follow the [quick start](README.md#quick-start--apple-silicon) and [configuration guide](docs/configuration.md). Read the [source overview](docs/development.md) before changing ingestion, storage, or tool contracts.

## Proposing a change

Open an issue with the use case or a reproducible bug. A focused pull request should explain the behavior change and how you verified it. Include meaningful coverage for changed behavior, especially document isolation, pagination, citations, and error handling.

Run `npm run check` before submitting. If your change affects the MLX service, also run `npm run test:mlx` in its prepared environment. For integration changes, `npm run test:live` uses real local services with a temporary collection and cleanup.

Keep tool definitions consistent across MCP, HTTP, and SDK. Update the English and Chinese home pages and relevant reference documentation when user-facing behavior changes. Preserve MCP stdout for JSON-RPC and keep logs on stderr.

## Data and artifacts

Do not commit API keys, `.env`, model weights, imported personal documents, local database storage, or private benchmark inputs. The repository ignores `.local/`, `storage/`, and `dist/`. Use synthetic or redistributable fixtures when reporting bugs.

Public evaluation contributions should name datasets and revisions, hardware, model revisions, preprocessing, query instructions, metrics, and the scope of the comparison.

Contributions are distributed under the repository's [MIT license](LICENSE).
