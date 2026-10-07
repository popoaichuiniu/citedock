import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createRagService } from "../src/rag.js";
import { QdrantStore } from "../src/store.js";

test(
  "real Qwen3 + Qdrant: semantic retrieval, replacement, isolation, model guards, and stdio MCP",
  { timeout: 180000 },
  async (t) => {
    const config = {
      ...loadConfig(),
      QDRANT_COLLECTION: `rag_test_${randomUUID().replaceAll("-", "")}`,
      CHUNK_SIZE: 128,
      CHUNK_OVERLAP: 16,
    };
    const rag = createRagService(config);
    const store = new QdrantStore(config);
    t.after(async () => {
      if (
        (await store.client.collectionExists(config.QDRANT_COLLECTION)).exists
      )
        await store.client.deleteCollection(config.QDRANT_COLLECTION);
    });
    await rag.ingest({
      source: "qdrant.md",
      text: "Qdrant 是向量数据库，可以持久化保存知识库向量，使用 Cosine 余弦相似度检索最相关的文本。",
    });
    await rag.ingest({
      source: "fruit.md",
      text: "香蕉是黄色的水果，富含钾。苹果可以榨汁。",
    });
    await rag.ingest({
      source: "private.md",
      namespace: "private",
      text: "内部私有知识，不能出现在 default namespace 的检索结果中。",
    });
    const found = await rag.search({
      query: "使用什么数据库保存向量并进行余弦相似度检索？",
      topK: 1,
    });
    assert.equal(found.matches[0]?.source, "qdrant.md");
    assert.ok(found.matches[0]!.score > 0);
    assert.match(found.context, /\[1\].*qdrant\.md/);
    assert.ok(
      (await rag.search({ query: "内部私有知识" })).matches.every(
        (match) => match.namespace === "default",
      ),
    );
    assert.equal(
      (await rag.search({ query: "向量", source: "not-found.md" })).matches
        .length,
      0,
    );
    const long = await rag.ingest({
      source: "replace.md",
      text: "Qdrant 保存向量，并检索相关文档。".repeat(30),
    });
    assert.ok(long.chunks > 1);
    const before = await store.client.count(config.QDRANT_COLLECTION, {
      exact: true,
    });
    await rag.ingest({
      source: "replace.md",
      text: "Qdrant 保存向量，并检索相关文档。".repeat(30),
    });
    assert.equal(
      (await store.client.count(config.QDRANT_COLLECTION, { exact: true }))
        .count,
      before.count,
    );
    await rag.ingest({
      source: "replace.md",
      text: "新版本知识，只保留一个分块。",
    });
    const shrunk = await rag.search({
      query: "新版本",
      source: "replace.md",
      topK: 20,
    });
    assert.equal(shrunk.matches.length, 1);
    assert.equal(shrunk.matches[0]!.text, "新版本知识，只保留一个分块。");
    await assert.rejects(
      new QdrantStore({
        ...config,
        EMBEDDING_DIMENSIONS: 512,
      }).ensureCollection(false),
      /mismatch/,
    );
    await assert.rejects(
      new QdrantStore({
        ...config,
        EMBEDDING_MODEL: "other-model",
      }).ensureCollection(false),
      /mismatch/,
    );
    const client = new Client({ name: "live-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/mcp.js", import.meta.url))],
      cwd: tmpdir(),
      env: {
        ...getDefaultEnvironment(),
        QDRANT_COLLECTION: config.QDRANT_COLLECTION,
        QDRANT_URL: config.QDRANT_URL,
        QDRANT_API_KEY: config.QDRANT_API_KEY,
        EMBEDDING_PROVIDER: config.EMBEDDING_PROVIDER,
        EMBEDDING_MODEL: config.EMBEDDING_MODEL,
        EMBEDDING_BASE_URL: config.EMBEDDING_BASE_URL,
        EMBEDDING_API_KEY: config.EMBEDDING_API_KEY,
        EMBEDDING_DIMENSIONS: String(config.EMBEDDING_DIMENSIONS),
      },
    });
    t.after(() => client.close());
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0]!.name, "rag_search");
    const call = await client.callTool(
      {
        name: "rag_search",
        arguments: { query: "如何存储向量？", source: "qdrant.md" },
      },
      { timeout: 120000 },
    );
    assert.ok(!call.isError);
    assert.equal(
      (call.structuredContent as { matches: { source: string }[] }).matches[0]!
        .source,
      "qdrant.md",
    );
    console.log(
      `Live semantic retrieval passed: ${found.matches[0]!.source}, cosine=${found.matches[0]!.score.toFixed(4)}; stdio MCP passed from another cwd.`,
    );
  },
);
