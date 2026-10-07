import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { test } from "node:test";
import { createHttpServer } from "../src/http-server.js";
import { MAX_PDF_BYTES } from "../src/schema.js";
import { close, fixture, listen } from "./helpers.js";

const pdfFile = (name: string) =>
  readFile(new URL(`./fixtures/pdf/${name}.pdf`, import.meta.url));

test("HTTP PDF upload uses binary data, authentication, namespace, and page citations", async (t) => {
  const { rag } = fixture();
  const server = createHttpServer(rag, { apiKey: "test-key" });
  const url = await listen(server);
  t.after(() => close(server));
  const body = new Uint8Array(await pdfFile("knowledge"));
  const path = "/v1/documents/pdf?source=guide.pdf&namespace=docs";
  assert.equal(
    (
      await fetch(url + path, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/pdf" },
      })
    ).status,
    401,
  );
  const response = await fetch(url + path, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/pdf",
      Authorization: "Bearer test-key",
    },
  });
  assert.equal(response.status, 200);
  const imported = (await response.json()) as {
    pageCount: number;
    emptyPages: number[];
  };
  assert.equal(imported.pageCount, 3);
  assert.deepEqual(imported.emptyPages, [2]);
  const result = await fetch(url + "/v1/tools/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
    body: JSON.stringify({
      name: "rag_search",
      arguments: { query: "向量", namespace: "docs", topK: 20 },
    }),
  });
  const found = (await result.json()) as {
    context: string;
    matches: { page?: number }[];
  };
  assert.equal(result.status, 200);
  assert.ok(found.matches.some((match) => match.page === 3));
  assert.match(found.context, /guide\.pdf.*page 3/);
});

test("HTTP rejects bad PDF uploads with clear client errors and preserves old knowledge", async (t) => {
  const { rag, store } = fixture();
  await rag.ingest({ source: "guide.pdf", text: "旧资料" });
  const previous = [...store.points.entries()];
  const server = createHttpServer(rag);
  const url = await listen(server);
  t.after(() => close(server));
  const upload = (
    body: Uint8Array,
    path = "/v1/documents/pdf?source=guide.pdf",
    type = "application/pdf",
  ) =>
    fetch(url + path, {
      method: "POST",
      body: new Uint8Array(body),
      headers: { "Content-Type": type },
    });
  const scanned = await upload(await pdfFile("image-only"));
  assert.equal(scanned.status, 400);
  assert.match(
    ((await scanned.json()) as { error: string }).error,
    /暂不支持扫描件 PDF/,
  );
  assert.equal((await upload(await pdfFile("encrypted"))).status, 400);
  assert.equal((await upload(Buffer.from("bad PDF"))).status, 400);
  assert.equal((await upload(new Uint8Array())).status, 400);
  assert.equal(
    (await upload(await pdfFile("knowledge"), "/v1/documents/pdf")).status,
    400,
  );
  assert.equal(
    (await upload(await pdfFile("knowledge"), undefined, "application/json"))
      .status,
    415,
  );
  assert.deepEqual([...store.points.entries()], previous);

  // A declared oversized body must be rejected before buffering or invoking the parser.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      url + "/v1/documents/pdf?source=guide.pdf",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": MAX_PDF_BYTES + 1,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end("%PDF-1.7\n");
  });
  assert.equal(status, 413);
});
