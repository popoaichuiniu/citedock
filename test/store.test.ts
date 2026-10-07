import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.js";
import { QdrantStore, type VectorPoint } from "../src/store.js";

const config = parseConfig({ EMBEDDING_DIMENSIONS: "2" });
function collectionInfo(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      params: { vectors: { size: 2, distance: "Cosine" } },
      metadata: {
        ragSchemaVersion: 1,
        embeddingModel: config.EMBEDDING_MODEL,
        embeddingProvider: "ollama",
        ...overrides,
      },
    },
  };
}
test("Qdrant refuses mixing embedding models or vector dimensions", async (t) => {
  const store = new QdrantStore(config);
  t.mock.method(store.client, "collectionExists", async () => ({
    exists: true,
  }));
  t.mock.method(store.client, "getCollection", async () =>
    collectionInfo({ embeddingModel: "different-model" }),
  );
  await assert.rejects(store.ensureCollection(false), /model\/provider/);
  t.mock.method(store.client, "getCollection", async () => ({
    config: { params: { vectors: { size: 3, distance: "Cosine" } } },
  }));
  await assert.rejects(
    store.ensureCollection(false),
    /size\/distance mismatch/,
  );
});
test("missing collection search returns empty without creating or deleting anything", async (t) => {
  const store = new QdrantStore(config);
  t.mock.method(store.client, "collectionExists", async () => ({
    exists: false,
  }));
  const create = t.mock.method(store.client, "createCollection");
  assert.deepEqual(
    await store.search([1, 0], { namespace: "default", topK: 5 }),
    [],
  );
  assert.equal(create.mock.callCount(), 0);
});
test("Qdrant query carries namespace, source, score threshold, and payload options", async (t) => {
  const store = new QdrantStore(config);
  t.mock.method(store.client, "collectionExists", async () => ({
    exists: true,
  }));
  t.mock.method(store.client, "getCollection", async () => collectionInfo());
  const query = t.mock.method(store.client, "query", async () => ({
    points: [],
  }));
  await store.search([1, 0], {
    namespace: "team-a",
    source: "guide.md",
    topK: 3,
    minScore: 0,
  });
  assert.deepEqual(query.mock.calls[0]!.arguments[1], {
    query: [1, 0],
    limit: 3,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        { key: "namespace", match: { value: "team-a" } },
        { key: "source", match: { value: "guide.md" } },
      ],
    },
    score_threshold: 0,
  });
});
test("failed Qdrant upsert never deletes old chunks", async (t) => {
  const store = new QdrantStore(config);
  t.mock.method(store.client, "collectionExists", async () => ({
    exists: true,
  }));
  t.mock.method(store.client, "getCollection", async () => collectionInfo());
  t.mock.method(store.client, "createPayloadIndex", async () => ({}));
  t.mock.method(store.client, "upsert", async () => {
    throw new Error("write unavailable");
  });
  const deletion = t.mock.method(store.client, "delete");
  const point: VectorPoint = {
    id: "7d444840-9dc0-51d1-b245-5ffdce74fad2",
    vector: [1, 0],
    payload: {
      documentId: "doc",
      namespace: "default",
      source: "doc.md",
      text: "text",
      chunkIndex: 0,
      startLine: 1,
      endLine: 1,
      metadata: {},
      embeddingModel: config.EMBEDDING_MODEL,
    },
  };
  await assert.rejects(
    store.replaceDocument("doc", [point]),
    /write unavailable/,
  );
  assert.equal(deletion.mock.callCount(), 0);
});

test("readiness refresh detects an outage after a successful collection check", async (t) => {
  const store = new QdrantStore(config);
  t.mock.method(store.client, "collectionExists", async () => ({
    exists: true,
  }));
  t.mock.method(store.client, "getCollection", async () => collectionInfo());
  assert.equal(await store.ensureCollection(false), true);
  t.mock.method(store.client, "collectionExists", async () => {
    throw new Error("Qdrant offline");
  });
  await assert.rejects(store.ensureCollection(false, true), /Qdrant offline/);
});

test("a later batch failure skips tail cleanup and a retry finishes replacement", async (t) => {
  const store = new QdrantStore(config);
  t.mock.method(store.client, "collectionExists", async () => ({
    exists: true,
  }));
  t.mock.method(store.client, "getCollection", async () => collectionInfo());
  t.mock.method(store.client, "createPayloadIndex", async () => ({}));
  const points: VectorPoint[] = Array.from(
    { length: 130 },
    (_, chunkIndex) => ({
      id: String(chunkIndex),
      vector: [1, 0],
      payload: {
        documentId: "doc",
        namespace: "default",
        source: "doc.md",
        text: "text",
        chunkIndex,
        startLine: 1,
        endLine: 1,
        metadata: {},
        embeddingModel: config.EMBEDDING_MODEL,
      },
    }),
  );
  let calls = 0;
  t.mock.method(store.client, "upsert", async () => {
    if (++calls === 2) throw new Error("second batch failed");
    return {};
  });
  const deletion = t.mock.method(store.client, "delete", async () => ({}));
  await assert.rejects(store.replaceDocument("doc", points), /second batch/);
  assert.equal(deletion.mock.callCount(), 0);
  const successfulWrite = t.mock.method(
    store.client,
    "upsert",
    async () => ({}),
  );
  await store.replaceDocument("doc", points);
  assert.deepEqual(
    successfulWrite.mock.calls.map((call) => {
      const request = call.arguments[1]!;
      assert.ok("points" in request);
      return request.points.length;
    }),
    [64, 64, 2],
  );
  assert.equal(deletion.mock.callCount(), 1);
  const deleteRequest = deletion.mock.calls[0]!.arguments[1]!;
  assert.ok("filter" in deleteRequest);
  assert.deepEqual(deleteRequest.filter, {
    must: [
      { key: "documentId", match: { value: "doc" } },
      { key: "chunkIndex", range: { gte: 130 } },
    ],
  });
});
