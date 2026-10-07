import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText } from "../src/chunker.js";
import { parseConfig } from "../src/config.js";
import { chunkId } from "../src/rag.js";
import { executeTool } from "../src/tools.js";
import { fixture } from "./helpers.js";

test("Unicode chunking preserves every code point, overlaps, and line numbers", () => {
  const input = "第一行😀\r\n第二行。第三行🚀很长";
  const chunks = chunkText(input, 8, 2);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk.text).length <= 8);
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(chunk.text));
  }
  const reconstructed =
    chunks[0]!.text +
    chunks
      .slice(1)
      .map((chunk) => Array.from(chunk.text).slice(2).join(""))
      .join("");
  assert.equal(reconstructed, input.replace(/\r\n/g, "\n"));
  assert.equal(chunks[0]!.startLine, 1);
  assert.equal(chunks.at(-1)!.endLine, 2);
  assert.deepEqual(chunkText(" \n\t", 8, 2), []);
  assert.throws(() => chunkText(input, 8, 8));
});
test("config rejects invalid overlap, malformed URLs, and unauthenticated public binding", () => {
  assert.throws(() => parseConfig({ CHUNK_SIZE: "100", CHUNK_OVERLAP: "100" }));
  assert.throws(() => parseConfig({ QDRANT_URL: "file:///tmp/qdrant" }));
  assert.throws(() => parseConfig({ HTTP_HOST: "0.0.0.0" }));
  assert.equal(
    parseConfig({ HTTP_HOST: "0.0.0.0", RAG_API_KEY: "secret" }).HTTP_HOST,
    "0.0.0.0",
  );
});
test("document replacement is idempotent, removes stale chunks, and isolates namespaces", async () => {
  const { rag, store } = fixture();
  const first = await rag.ingest({
    source: "guide.md",
    text: "知识库检索。".repeat(40),
  });
  const firstIds = [...store.points.keys()];
  const repeated = await rag.ingest({
    source: "guide.md",
    text: "知识库检索。".repeat(40),
  });
  assert.deepEqual(first, repeated);
  assert.deepEqual([...store.points.keys()], firstIds);
  assert.match(
    firstIds[0]!,
    /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  assert.equal(chunkId(first.documentId, 0), firstIds[0]);
  await rag.ingest({
    source: "guide.md",
    namespace: "private",
    text: "另一个 namespace",
  });
  await rag.ingest({ source: "guide.md", text: "更新后的文档" });
  assert.equal(store.points.size, 2);
  const result = await rag.search({ query: "文档" });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.text, "更新后的文档");
  assert.match(result.context, /\[1\].*guide\.md.*lines 1-1/);
  assert.equal(
    (await rag.search({ query: "文档", namespace: "missing" })).matches.length,
    0,
  );
});
test("embedding failure leaves the previous document intact", async () => {
  const { rag, store, embedder } = fixture();
  await rag.ingest({ source: "guide.md", text: "旧知识" });
  embedder.embedDocuments = async () => {
    throw new Error("offline");
  };
  await assert.rejects(
    rag.ingest({ source: "guide.md", text: "新知识" }),
    /offline/,
  );
  assert.equal([...store.points.values()][0]!.payload.text, "旧知识");
});
test("simultaneous updates of one document execute in request order", async () => {
  const { rag, embedder, store } = fixture();
  const observed: string[] = [];
  embedder.embedDocuments = async (texts) => {
    observed.push(texts[0]!);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return texts.map(() => [1, 0]);
  };
  await Promise.all([
    rag.ingest({ source: "same.md", text: "first" }),
    rag.ingest({ source: "same.md", text: "second" }),
  ]);
  assert.deepEqual(observed, ["first", "second"]);
  assert.equal([...store.points.values()][0]!.payload.text, "second");
});
test("context obeys the Unicode character budget and tool dispatch validates arguments", async () => {
  const { rag } = fixture();
  await rag.ingest({ source: "long.md", text: "😀知识".repeat(150) });
  const result = await executeTool(rag, "rag_search", {
    query: "知识",
    topK: 20,
    maxContextChars: 256,
  });
  assert.equal(Array.from(result.context).length, 256);
  assert.equal(result.truncated, true);
  await assert.rejects(executeTool(rag, "run_shell", {}), /Unknown tool/);
  await assert.rejects(
    executeTool(rag, "rag_search", { query: " ", topK: 21 }),
  );
  await assert.rejects(rag.ingest({ source: "blank.txt", text: " \n " }));
});
