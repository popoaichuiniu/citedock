import assert from "node:assert/strict";
import { test } from "node:test";
import { DocumentExistsError, DocumentNotFoundError } from "../src/rag.js";
import { executeTool } from "../src/tools.js";
import { fixture } from "./helpers.js";

const target = { namespace: "default", source: "notes.md" };

test("document tools create, browse, replace all chunks, and delete an exact source", async () => {
  const { rag, store } = fixture();
  const created = await executeTool(rag, "rag_add_document", {
    ...target,
    text: "原始知识库资料。".repeat(30),
    metadata: { category: "notes" },
  });
  assert.ok(created.chunks > 1);
  await rag.addDocument({ ...target, namespace: "private", text: "私有文档" });
  const list = await executeTool(rag, "rag_list_documents", {});
  assert.equal(list.totalDocuments, 1);
  assert.equal(list.documents[0]!.source, target.source);
  const first = await executeTool(rag, "rag_get_document", {
    ...target,
    limit: 1,
  });
  assert.equal(first.total, created.chunks);
  assert.equal(first.chunks.length, 1);
  assert.equal(first.chunks[0]!.metadata.category, "notes");
  assert.equal(first.nextAfter, 1);
  const second = await rag.getDocument({
    ...target,
    after: first.nextAfter!,
    limit: 1,
  });
  assert.equal(second.chunks[0]!.chunkIndex, 1);

  const updated = await executeTool(rag, "rag_update_document", {
    ...target,
    text: "这是完整的新版本。",
  });
  assert.equal(updated.documentId, created.documentId);
  assert.equal(updated.chunks, 1);
  const changed = await rag.getDocument(target);
  assert.equal(changed.total, 1);
  assert.equal(changed.chunks[0]!.text, "这是完整的新版本。");
  assert.deepEqual(changed.chunks[0]!.metadata, {});
  assert.equal(store.points.size, 2);

  const deleted = await executeTool(rag, "rag_delete_document", target);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.deletedChunks, 1);
  assert.equal((await rag.listDocuments()).totalDocuments, 0);
  assert.equal(
    (await rag.search({ query: "新版本", source: target.source })).matches
      .length,
    0,
  );
  assert.equal(
    (await rag.getDocument({ ...target, namespace: "private" })).chunks[0]!
      .text,
    "私有文档",
  );
  assert.equal((await rag.deleteDocument(target)).deleted, false);
  await assert.rejects(rag.getDocument(target), DocumentNotFoundError);
});

test("creation conflicts and missing updates cannot overwrite or silently create documents", async (t) => {
  const { rag, embedder } = fixture();
  await rag.addDocument({ ...target, text: "现有内容" });
  const embed = t.mock.method(embedder, "embedDocuments");
  await assert.rejects(
    rag.addDocument({ ...target, text: "意外覆盖" }),
    DocumentExistsError,
  );
  await assert.rejects(
    rag.updateDocument({ ...target, namespace: "missing", text: "新内容" }),
    DocumentNotFoundError,
  );
  assert.equal(embed.mock.callCount(), 0);
  assert.equal((await rag.getDocument(target)).chunks[0]!.text, "现有内容");
});

test("mutation tools require explicit exact targets and reject invalid replacement text", async () => {
  const { rag, store } = fixture();
  for (const name of [
    "rag_add_document",
    "rag_update_document",
    "rag_delete_document",
  ] as const) {
    await assert.rejects(
      executeTool(rag, name, { source: "notes.md", text: "正文" }),
    );
    await assert.rejects(
      executeTool(rag, name, {
        namespace: "default",
        query: "全部文档",
        text: "正文",
      }),
    );
  }
  await assert.rejects(rag.addDocument({ ...target, text: " \n " }));
  await assert.rejects(
    executeTool(rag, "rag_add_document", {
      ...target,
      text: "正文",
      metadata: { nested: {} },
    }),
  );
  assert.equal(store.points.size, 0);
});

test("failed replacement keeps old content and releases the mutation queue", async () => {
  const { rag, embedder } = fixture();
  await rag.addDocument({ ...target, text: "旧内容" });
  embedder.embedDocuments = async () => {
    throw new Error("Embedding offline");
  };
  await assert.rejects(
    rag.updateDocument({ ...target, text: "新内容" }),
    /offline/,
  );
  assert.equal((await rag.getDocument(target)).chunks[0]!.text, "旧内容");
  assert.equal((await rag.deleteDocument(target)).deleted, true);
});

test("deletion queued during embedding runs after the write and cannot leave resurrected chunks", async () => {
  const { rag, embedder, store } = fixture();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  embedder.embedDocuments = async (texts) => {
    started();
    await gate;
    return texts.map(() => [1, 0]);
  };
  const adding = rag.addDocument({ ...target, text: "正在写入的内容" });
  await ready;
  const deleting = rag.deleteDocument(target);
  release();
  await adding;
  assert.equal((await deleting).deletedChunks, 1);
  assert.equal(store.points.size, 0);
});

test("concurrent additions to one source have one winner within the same service", async () => {
  const { rag } = fixture();
  const results = await Promise.allSettled([
    rag.addDocument({ ...target, text: "first" }),
    rag.addDocument({ ...target, text: "second" }),
  ]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.equal(results[1]!.status, "rejected");
  if (results[1]!.status === "rejected")
    assert.ok(results[1]!.reason instanceof DocumentExistsError);
  assert.equal((await rag.getDocument(target)).chunks[0]!.text, "first");
});
