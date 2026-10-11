# Publishing CiteDock

The public repository is [popoaichuiniu/citedock](https://github.com/popoaichuiniu/citedock), with `main` as the source branch. This file records repository metadata and preparation for future releases; no release or npm package has been published.

## Repository metadata

Repository name: **citedock**

About description:

> A local knowledge base for AI agents. Search, cite, and manage documents through MCP, with Qdrant, Qwen3 embeddings, and a web UI.

Topics:

```text
mcp mcp-server rag qdrant qwen3 embeddings mlx typescript
knowledge-base semantic-search pdf ai-agents local-first document-management
```

The name connects citations with a place where documents and agents meet. A preliminary public search found no clear software match; it is not a trademark clearance or proof that every package namespace is available. The package remains private and is not being published to npm.

## Maintaining the public repository

1. Review the [MIT license](../LICENSE), tracked files, commit history, and demo assets before publishing new changes.
2. Commit the prepared source and push to `origin/main` at the repository above.
3. Confirm the actual GitHub CI result before adding a status badge or creating a release.
4. Keep GitHub About and topics aligned with the copy above.
5. Enable private vulnerability reporting in repository settings.
6. Use [the social preview](assets/social-preview.png) for the repository image and the real [dashboard](assets/dashboard.png), [PDF citations](assets/pdf-citations.png), and [search](assets/search.png) screenshots for a demo.
7. Create the first release only when you are ready; use [the changelog](../CHANGELOG.md) as the basis.

The workflow runs `npm ci` and `npm run check` on Node 22 and 24. Model downloads and live GPU tests are optional local checks rather than public CI prerequisites.

## Sharing the project

Lead with the concrete use case: an agent can search, cite, and maintain a local knowledge base, while you can inspect its documents in a browser.

English draft:

> Meet CiteDock: a local knowledge base your AI agents can search, cite, and maintain. Six MCP tools, PDF page citations, document CRUD, and a web dashboard. Built with TypeScript, Qdrant, and Qwen3 embeddings, with MLX on Apple Silicon or your existing embedding endpoint.

中文草稿：

> CiteDock：让 AI Agent 检索、引用和维护本地知识库。支持六个 MCP 工具、PDF 原始页码引用、文档增删改，以及可浏览实际数据的网页后台。TypeScript + Qdrant + Qwen3 Embedding，支持 Apple Silicon MLX、Ollama 和 OpenAI 兼容接口。

Attach the repository URL and a real demo. State platform requirements and scanned-PDF limitations clearly. Invite focused feedback and reproducible evaluations. Repository naming and presentation can help discovery; star growth depends on usefulness, documentation, maintenance, and who sees it.
