import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { QwenEmbedder } from "../src/embedding.js";
import { createRagService } from "../src/rag.js";
import { QdrantStore } from "../src/store.js";
import { createHttpServer } from "../src/http-server.js";
import { close, listen } from "./helpers.js";
import type { ChunkList, DocumentList } from "../src/schema.js";

const execFileAsync = promisify(execFile);

test(
  "real Qwen3 + Qdrant: semantic retrieval, PDF CLI/HTTP imports, page citations, replacement, isolation, and MCP",
  { timeout: 180000 },
  async (t) => {
    const config = {
      ...loadConfig(),
      QDRANT_COLLECTION: `rag_test_${randomUUID().replaceAll("-", "")}`,
      CHUNK_SIZE: 128,
      CHUNK_OVERLAP: 16,
    };
    const rag = createRagService(config);
    assert.equal((await rag.listDocuments()).totalDocuments, 0);
    assert.deepEqual((await rag.listNamespaces()).namespaces, []);
    const embedder = new QwenEmbedder(config);
    const shortText = "香蕉是一种水果。";
    const single = (await embedder.embedDocuments([shortText]))[0]!;
    const batched = await embedder.embedDocuments([
      "Qdrant 是向量数据库。".repeat(10),
      shortText,
    ]);
    assert.equal(single.length, config.EMBEDDING_DIMENSIONS);
    assert.ok(Math.abs(Math.hypot(...single) - 1) < 1e-6);
    assert.ok(
      Math.hypot(...single.map((v, i) => v - batched[1]![i]!)) < 1e-5,
      "Batching with a longer input must not change the short input's embedding",
    );
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
    const documents = await rag.listDocuments({ limit: 1 });
    assert.equal(documents.totalDocuments, 3);
    const seen = new Set(documents.documents.map((doc) => doc.documentId));
    let cursor = documents.nextCursor;
    while (cursor) {
      const page: DocumentList = await rag.listDocuments({ limit: 1, cursor });
      for (const document of page.documents) {
        assert.ok(!seen.has(document.documentId));
        seen.add(document.documentId);
      }
      cursor = page.nextCursor;
    }
    assert.equal(seen.size, 3);
    const chunkIndexes: number[] = [];
    let after: number | null = 0;
    while (after !== null) {
      const page: ChunkList = await rag.listChunks(long.documentId, {
        limit: 2,
        after,
      });
      assert.equal(page.total, long.chunks);
      chunkIndexes.push(...page.chunks.map((chunk) => chunk.chunkIndex));
      after = page.nextAfter;
    }
    assert.deepEqual(
      chunkIndexes,
      Array.from({ length: long.chunks }, (_, index) => index),
    );
    assert.equal(
      (await rag.listChunks(long.documentId, { namespace: "private" })).total,
      0,
    );
    assert.deepEqual(
      (await rag.listNamespaces()).namespaces.map((item) => item.namespace),
      ["default", "private"],
    );
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
    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const pdfPath = fileURLToPath(
      new URL("./fixtures/pdf/knowledge.pdf", import.meta.url),
    );
    const cliOptions = {
      cwd: tmpdir(),
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(config).map(([key, value]) => [key, String(value)]),
        ),
      },
    };
    const importedPdf = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "ingest",
        pdfPath,
        "--namespace",
        "pdf",
        "--source",
        "guide.pdf",
      ],
      cliOptions,
    );
    assert.equal(JSON.parse(importedPdf.stdout).pageCount, 3);
    const pdfFound = await rag.search({
      query: "PDF 导入如何保留原始页码？",
      namespace: "pdf",
      source: "guide.pdf",
      topK: 1,
    });
    assert.equal(pdfFound.matches[0]?.page, 3);
    assert.match(pdfFound.context, /guide\.pdf.*page 3/);
    const countBeforeFailure = (
      await store.client.count(config.QDRANT_COLLECTION, { exact: true })
    ).count;
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cliPath,
          "ingest",
          fileURLToPath(
            new URL("./fixtures/pdf/image-only.pdf", import.meta.url),
          ),
          "--namespace",
          "pdf",
          "--source",
          "guide.pdf",
        ],
        cliOptions,
      ),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        String(error.stderr).includes("暂不支持扫描件 PDF"),
    );
    assert.equal(
      (await store.client.count(config.QDRANT_COLLECTION, { exact: true }))
        .count,
      countBeforeFailure,
    );
    const http = createHttpServer(rag);
    const baseUrl = await listen(http);
    t.after(() => close(http));
    const httpImported = await fetch(
      `${baseUrl}/v1/documents/pdf?source=http-guide.pdf&namespace=pdf-http`,
      {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(await readFile(pdfPath)),
      },
    );
    assert.equal(httpImported.status, 200);
    assert.equal(
      ((await httpImported.json()) as { pageCount: number }).pageCount,
      3,
    );
    const listedResponse = await fetch(
      `${baseUrl}/v1/documents?namespace=pdf-http`,
    );
    assert.equal(listedResponse.status, 200);
    const listed = (await listedResponse.json()) as DocumentList;
    assert.equal(listed.totalDocuments, 1);
    assert.equal(listed.documents[0]!.pageCount, 3);
    const browsedResponse = await fetch(
      `${baseUrl}/v1/documents/${listed.documents[0]!.documentId}/chunks?namespace=pdf-http`,
    );
    assert.equal(browsedResponse.status, 200);
    const browsed = (await browsedResponse.json()) as ChunkList;
    assert.deepEqual(
      [...new Set(browsed.chunks.map((chunk) => chunk.page))],
      [1, 3],
    );
    const httpFound = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "rag_search",
        arguments: {
          query: "PDF 导入如何保留原始页码？",
          namespace: "pdf-http",
          topK: 1,
        },
      }),
    });
    assert.equal(httpFound.status, 200);
    assert.equal(
      ((await httpFound.json()) as { matches: { page: number }[] }).matches[0]
        ?.page,
      3,
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
    const pdfCall = await client.callTool(
      {
        name: "rag_search",
        arguments: {
          query: "PDF 导入如何保留原始页码？",
          namespace: "pdf",
          source: "guide.pdf",
          topK: 1,
        },
      },
      { timeout: 120000 },
    );
    assert.ok(!pdfCall.isError);
    assert.equal(
      (pdfCall.structuredContent as { matches: { page: number }[] }).matches[0]
        ?.page,
      3,
    );
    console.log(
      `Live semantic retrieval passed: ${found.matches[0]!.source}, cosine=${found.matches[0]!.score.toFixed(4)}; PDF CLI/HTTP import and page 3 citations passed; stdio MCP passed from another cwd.`,
    );
  },
);
