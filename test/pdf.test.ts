import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { documentFiles } from "../src/files.js";
import { extractPdf, PdfImportError } from "../src/pdf.js";
import { MAX_PDF_BYTES } from "../src/schema.js";
import { fixture } from "./helpers.js";

const pdfFile = (name: string) =>
  readFile(new URL(`./fixtures/pdf/${name}.pdf`, import.meta.url));

test("PDF extraction preserves English, Chinese, original page numbers, and the caller's buffer", async () => {
  const data = await pdfFile("knowledge");
  const before = Buffer.from(data);
  const result = await extractPdf(data);
  assert.equal(result.pageCount, 3);
  assert.deepEqual(result.emptyPages, [2]);
  assert.deepEqual(
    result.pages.map((page) => page.page),
    [1, 3],
  );
  assert.match(result.pages[0]!.text, /Qdrant stores vectors/);
  assert.match(result.pages[1]!.text, /知识库向量检索/);
  assert.match(result.pages[1]!.text, /4096 维向量/);
  assert.deepEqual(data, before);
});

test("scanned, encrypted, invalid, empty, and oversized PDFs fail clearly", async () => {
  await assert.rejects(
    extractPdf(await pdfFile("image-only")),
    /暂不支持扫描件 PDF/,
  );
  await assert.rejects(
    extractPdf(await pdfFile("mixed")),
    /暂不支持扫描件 PDF：第 2 页/,
  );
  await assert.rejects(extractPdf(await pdfFile("encrypted")), /加密 PDF/);
  await assert.rejects(extractPdf(Buffer.from("not a PDF")), PdfImportError);
  await assert.rejects(
    extractPdf(Buffer.from("%PDF-1.7\ninvalid content")),
    /损坏|不受支持/,
  );
  await assert.rejects(extractPdf(new Uint8Array()), /1 byte/);
  await assert.rejects(extractPdf(new Uint8Array(MAX_PDF_BYTES + 1)), /32 MiB/);
});

test("PDF ingestion is idempotent, chunks within pages, and returns page citations", async () => {
  const { rag, store } = fixture();
  const input = {
    data: await pdfFile("knowledge"),
    source: "guide.pdf",
    namespace: "docs",
    metadata: { category: "reference" },
  };
  const first = await rag.ingestPdf(input);
  const ids = [...store.points.keys()];
  assert.equal(first.pageCount, 3);
  assert.deepEqual(first.emptyPages, [2]);
  assert.ok(first.chunks > 2);
  assert.deepEqual(await rag.ingestPdf(input), first);
  assert.deepEqual([...store.points.keys()], ids);
  for (const point of store.points.values()) {
    assert.ok([1, 3].includes(point.payload.page!));
    assert.equal(point.payload.metadata.category, "reference");
    assert.equal(point.payload.metadata.format, "pdf");
    assert.equal(point.payload.metadata.pageCount, 3);
  }
  const found = await rag.search({
    query: "向量",
    namespace: "docs",
    topK: 20,
  });
  assert.match(found.context, /guide\.pdf.*page 3, lines/);
  assert.equal((await rag.search({ query: "向量" })).matches.length, 0);
});

test("PDF parsing failure preserves existing knowledge and never calls the embedder", async () => {
  const { rag, store, embedder } = fixture();
  await rag.ingest({ source: "guide.pdf", text: "旧知识不能被失败的导入覆盖" });
  const oldPoints = [...store.points.entries()];
  let calls = 0;
  embedder.embedDocuments = async () => {
    calls++;
    return [];
  };
  for (const name of ["image-only", "mixed", "encrypted"]) {
    await assert.rejects(
      rag.ingestPdf({ source: "guide.pdf", data: await pdfFile(name) }),
      PdfImportError,
    );
    assert.deepEqual([...store.points.entries()], oldPoints);
  }
  assert.equal(calls, 0);
});

test("PDF and text updates to the same source keep request order and remove old page fields", async () => {
  const { rag, store } = fixture();
  const data = await pdfFile("knowledge");
  const [pdf] = await Promise.all([
    rag.ingestPdf({ source: "guide.pdf", data }),
    rag.ingest({ source: "guide.pdf", text: "后来的版本" }),
  ]);
  assert.ok(pdf.chunks > 1);
  assert.equal(store.points.size, 1);
  const point = [...store.points.values()][0]!;
  assert.equal(point.payload.text, "后来的版本");
  assert.equal(point.payload.page, undefined);
});

test("directory import finds PDFs and text together, while skipping hidden paths and symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rag-pdf-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "nested"));
  await mkdir(join(dir, "storage"));
  for (const file of [
    "a.PDF",
    "b.md",
    ".hidden.pdf",
    "nested/c.txt",
    "storage/ignored.pdf",
    "unsupported.docx",
  ])
    await writeFile(join(dir, file), "fixture");
  await symlink(join(dir, "nested"), join(dir, "linked"));
  await symlink(join(dir, "a.PDF"), join(dir, "linked.pdf"));
  assert.deepEqual(await documentFiles(dir), [
    join(dir, "a.PDF"),
    join(dir, "b.md"),
    join(dir, "nested/c.txt"),
  ]);
  assert.deepEqual(await documentFiles(join(dir, "a.PDF")), [
    join(dir, "a.PDF"),
  ]);
  await assert.rejects(
    documentFiles(join(dir, "unsupported.docx")),
    /Unsupported file type/,
  );
});
