import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { QwenEmbedder } from "../src/embedding.js";
import { close, listen } from "./helpers.js";

test("Ollama adapter batches documents, instructs queries, disables truncation, and normalizes", async (t) => {
  const calls: { url: string; input: string[]; truncate: boolean }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const data of req) raw += data;
    const body = JSON.parse(raw) as { input: string[]; truncate: boolean };
    calls.push({ url: req.url!, ...body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ embeddings: body.input.map(() => [3, 4, 12]) }));
  });
  const baseUrl = await listen(server);
  t.after(() => close(server));
  const embedder = new QwenEmbedder(
    parseConfig({
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_BASE_URL: baseUrl,
      EMBEDDING_BATCH_SIZE: "2",
      EMBEDDING_DIMENSIONS: "2",
    }),
  );
  assert.deepEqual(await embedder.embedDocuments(["文档1", "文档2", "文档3"]), [
    [0.6, 0.8],
    [0.6, 0.8],
    [0.6, 0.8],
  ]);
  await embedder.embedQuery("如何检索？");
  assert.deepEqual(
    calls.map((call) => call.input.length),
    [2, 1, 1],
  );
  assert.deepEqual(calls[0]!.input, ["文档1", "文档2"]);
  assert.ok(
    calls.every((call) => call.url === "/api/embed" && call.truncate === false),
  );
  assert.match(calls[2]!.input[0]!, /^Instruct: .*\nQuery: 如何检索？$/);
});
test("OpenAI adapter restores response order and sends bearer authentication", async (t) => {
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(req.headers.authorization, "Bearer test-key");
    for await (const _ of req) {
      /* drain */
    }
    res.end(
      JSON.stringify({
        data: [
          { index: 1, embedding: [0, 5] },
          { index: 0, embedding: [3, 0] },
        ],
      }),
    );
  });
  const baseUrl = await listen(server);
  t.after(() => close(server));
  const embedder = new QwenEmbedder(
    parseConfig({
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_BASE_URL: `${baseUrl}/v1/`,
      EMBEDDING_API_KEY: "test-key",
      EMBEDDING_DIMENSIONS: "2",
    }),
  );
  assert.deepEqual(await embedder.embedDocuments(["one", "two"]), [
    [1, 0],
    [0, 1],
  ]);
});
test("embedding adapter rejects upstream failures, bad counts, short and zero vectors", async (t) => {
  let body: unknown = { embeddings: [[0, 0]] };
  let status = 200;
  const server = createServer((_req, res) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  });
  const baseUrl = await listen(server);
  t.after(() => close(server));
  const embedder = new QwenEmbedder(
    parseConfig({
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_BASE_URL: baseUrl,
      EMBEDDING_DIMENSIONS: "2",
    }),
  );
  await assert.rejects(embedder.embedDocuments(["doc"]), /zero vector/);
  body = { embeddings: [[1]] };
  await assert.rejects(embedder.embedDocuments(["doc"]), /dimension mismatch/);
  body = { embeddings: [] };
  await assert.rejects(embedder.embedDocuments(["doc"]), /count/);
  status = 401;
  await assert.rejects(embedder.embedDocuments(["doc"]), /HTTP 401/);
});
test("OpenAI adapter rejects duplicate indices", async (t) => {
  const server = createServer((_req, res) =>
    res.end(
      JSON.stringify({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      }),
    ),
  );
  const baseUrl = await listen(server);
  t.after(() => close(server));
  const embedder = new QwenEmbedder(
    parseConfig({
      EMBEDDING_PROVIDER: "openai",
      EMBEDDING_BASE_URL: baseUrl,
      EMBEDDING_DIMENSIONS: "2",
    }),
  );
  await assert.rejects(
    embedder.embedDocuments(["one", "two"]),
    /duplicate indices/,
  );
});
