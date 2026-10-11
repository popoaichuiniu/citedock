# Use CiteDock as an agent skill

[Home](../README.md) · [中文](../README.zh-CN.md) · [Tool reference](tools.md)

The repository includes a portable [CiteDock skill](../skills/citedock/SKILL.md). It teaches a local command-line agent to search and cite evidence, import files, and maintain documents through the CLI. All six operations use the same validation and application service as MCP and HTTP.

The execution path is:

```text
Agent → SKILL.md instructions → CiteDock CLI → RagService → Qdrant / embeddings
```

Only Qdrant and the configured embedding service need to run. A web server and MCP registration are optional. Listing, reading, and deleting documents do not invoke embeddings. The skill still needs a local agent with shell/file access; an ordinary hosted model API cannot execute the local CLI by loading a Markdown file.

## Install for Codex

Codex discovers user skills under `~/.agents/skills`. From this checkout, copy the skill there if it is not already installed:

```bash
test ! -e "$HOME/.agents/skills/citedock" && \
  mkdir -p "$HOME/.agents/skills" && \
  cp -R skills/citedock "$HOME/.agents/skills/citedock"
```

If the target already exists, inspect it before updating its files. The folder contains only instructions and UI metadata; keep the actual application checkout and its `.env` in place. Codex detects skill changes automatically; restart it if the skill does not appear. See [the official skill documentation](https://developers.openai.com/codex/skills/).

Set the checkout location in your agent's environment, or provide it in the first request:

```bash
export CITEDOCK_DIR="/ABSOLUTE/PATH/TO/citedock"
```

Try these prompts:

> Use $citedock to search my local knowledge base for deployment requirements and cite the original sources. The checkout is /ABSOLUTE/PATH/TO/citedock.
>
> 用 $citedock 把这份会议记录保存到 default 知识库，source 为 meeting-notes.md。
>
> 用 $citedock 列出 default 知识库的文档，再读取 meeting-notes.md。

Other skill-capable agents can install the same `skills/citedock` folder using their own skill discovery mechanism. The optional `agents/openai.yaml` only supplies Codex UI metadata.

## CLI calls

Build/install the checkout as described in the README, and start Qdrant and embeddings. Discover the contracts without contacting either service:

```bash
npm --prefix "$CITEDOCK_DIR" run --silent rag -- tools
```

Write an arguments object to a UTF-8 JSON file. For example:

```json
{
  "namespace": "default",
  "source": "meeting-notes.md",
  "text": "The team chose Qdrant to store knowledge vectors.",
  "metadata": { "category": "meeting" }
}
```

Then call the appropriate tool:

```bash
npm --prefix "$CITEDOCK_DIR" run --silent rag -- call rag_add_document --args-file /ABSOLUTE/PATH/TO/args.json
```

`call` supports all six tools listed in [the reference](tools.md). Supply only their arguments object, not a `{name, arguments}` envelope. A file or stdin (`--args-file -`) is limited to 8 MiB. `--silent` removes npm's script banner, leaving JSON results on stdout; failures exit nonzero and print the error on stderr. Temporary argument files should be removed after use.

File import uses the existing `ingest` command:

```bash
npm --prefix "$CITEDOCK_DIR" run --silent rag -- ingest /ABSOLUTE/PATH/TO/reference.pdf --namespace default --source reference.pdf
```

Import replaces an existing document with the same namespace/source. The add tool instead rejects an existing document. Updates replace complete text and clear omitted metadata. Text-tool updates to PDFs lose page attributes; re-import the revised PDF to retain page citations.

## Skill and MCP

A skill packages instructions and workflow knowledge. Here it directs an agent with shell access to use the CLI. MCP provides a standard protocol for clients to discover and invoke tools. Both access the same database through CiteDock's application service; neither stores the data itself.

Choose the skill for a local command-line agent that can execute commands. Use MCP for a client that supports tool registration but does not offer local shell access. They can also work together. See the [MCP introduction](https://modelcontextprotocol.io/docs/getting-started/intro) for the protocol's role.
