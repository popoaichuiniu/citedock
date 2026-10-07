import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHttpServer } from "../src/http-server.js";
import type { ChunkList, DocumentList, NamespaceList } from "../src/schema.js";
import { close, fixture, listen } from "./helpers.js";

test("management shell is public, APIs remain authenticated, and static routes are allowlisted", async (t) => {
  const { rag } = fixture();
  const server = createHttpServer(rag, { apiKey: "hidden-key" });
  const url = await listen(server);
  t.after(() => close(server));
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(
    page.headers.get("content-security-policy")!,
    /script-src 'self'/,
  );
  const html = await page.text();
  assert.match(html, /已存资料/);
  assert.match(html, /type="file"\s+multiple/);
  assert.ok(!html.includes("hidden-key"));
  for (const asset of ["styles.css", "app.js"]) {
    const response = await fetch(`${url}/assets/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await response.text()).length > 100);
  }
  for (const path of [
    "/v1/documents",
    "/v1/namespaces",
    `/v1/documents/${"a".repeat(64)}/chunks`,
  ])
    assert.equal((await fetch(`${url}${path}`)).status, 401);
  assert.equal(
    (
      await fetch(`${url}/assets/.env`, {
        headers: { Authorization: "Bearer hidden-key" },
      })
    ).status,
    404,
  );
});

test("browsing reads persisted documents, paginates without duplicates, and isolates namespaces without embedding", async (t) => {
  const { rag, embedder } = fixture();
  const first = await rag.ingest({
    source: "<script>unsafe</script>.md",
    text: "知识库里的真实正文。".repeat(40),
    namespace: "team-a",
  });
  await rag.ingest({
    source: "other.txt",
    text: "第二份资料",
    namespace: "team-a",
  });
  await rag.ingest({
    source: "private.txt",
    text: "另一个知识库的正文",
    namespace: "team-b",
  });
  embedder.embedQuery = async () => {
    throw new Error("Browsing must not embed");
  };
  const server = createHttpServer(rag);
  const url = await listen(server);
  t.after(() => close(server));
  const get = async <T>(path: string) => {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    return (await response.json()) as T;
  };
  const page1 = await get<DocumentList>(
    "/v1/documents?namespace=team-a&limit=1",
  );
  assert.equal(page1.totalDocuments, 2);
  assert.equal(page1.totalChunks, first.chunks + 1);
  assert.equal(page1.documents.length, 1);
  assert.ok(page1.nextCursor);
  const page2 = await get<DocumentList>(
    `/v1/documents?namespace=team-a&limit=1&cursor=${page1.nextCursor}`,
  );
  assert.equal(page2.nextCursor, null);
  assert.notEqual(
    page1.documents[0]!.documentId,
    page2.documents[0]!.documentId,
  );
  assert.ok(
    [...page1.documents, ...page2.documents].every(
      (doc) => doc.namespace === "team-a",
    ),
  );
  const ids: string[] = [];
  let after: number | null = 0;
  while (after !== null) {
    const page: ChunkList = await get<ChunkList>(
      `/v1/documents/${first.documentId}/chunks?namespace=team-a&limit=2&after=${after}`,
    );
    assert.equal(page.total, first.chunks);
    assert.ok(
      page.chunks.every(
        (chunk) =>
          chunk.source === "<script>unsafe</script>.md" && !("vector" in chunk),
      ),
    );
    ids.push(...page.chunks.map((chunk) => chunk.id));
    after = page.nextAfter;
  }
  assert.equal(ids.length, first.chunks);
  assert.equal(new Set(ids).size, first.chunks);
  const isolated = await get<ChunkList>(
    `/v1/documents/${first.documentId}/chunks?namespace=team-b`,
  );
  assert.equal(isolated.total, 0);
  assert.deepEqual(isolated.chunks, []);
  const namespaces = await get<NamespaceList>("/v1/namespaces");
  assert.equal(namespaces.namespaces.length, 2);
  assert.equal(
    (await get<DocumentList>("/v1/documents?namespace=empty")).totalDocuments,
    0,
  );
  for (const path of [
    "/v1/documents?cursor=bad",
    "/v1/documents?limit=1000",
    "/v1/documents?unexpected=1",
    "/v1/documents/bad/chunks",
    `/v1/documents/${first.documentId}/chunks?after=-1`,
  ])
    assert.equal((await fetch(`${url}${path}`)).status, 400);
});

test("PDF browsing reports original pages and updated document counts", async () => {
  const { rag } = fixture();
  const pdf = await rag.ingestPdf({
    source: "guide.pdf",
    data: await readFile(
      new URL("fixtures/pdf/knowledge.pdf", import.meta.url),
    ),
  });
  const listing = await rag.listDocuments();
  assert.equal(listing.documents[0]!.pageCount, 3);
  assert.equal(listing.documents[0]!.chunks, pdf.chunks);
  const chunks = await rag.listChunks(pdf.documentId);
  assert.deepEqual(
    [...new Set(chunks.chunks.map((chunk) => chunk.page))],
    [1, 3],
  );
  await rag.ingest({ source: "guide.pdf", text: "已替换成纯文本" });
  const updated = await rag.listDocuments();
  assert.equal(updated.totalDocuments, 1);
  assert.equal(updated.totalChunks, 1);
  assert.equal(updated.documents[0]!.pageCount, undefined);
});
