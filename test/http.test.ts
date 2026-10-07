import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpServer } from "../src/http-server.js";
import { close, fixture, listen } from "./helpers.js";

test("HTTP API authenticates, validates input, imports documents, and dispatches model tools", async (t) => {
  const { rag } = fixture();
  const server = createHttpServer(rag, { apiKey: "test-key" });
  const url = await listen(server);
  t.after(() => close(server));
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer test-key",
  };
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/v1/tools`)).status, 401);
  const tools = await fetch(`${url}/v1/tools`, { headers });
  assert.equal(
    ((await tools.json()) as { tools: { function: { name: string } }[] })
      .tools[0]!.function.name,
    "rag_search",
  );
  assert.equal(
    (
      await post("/v1/documents", {
        source: "guide.md",
        text: "Qdrant 保存知识库向量",
      })
    ).status,
    200,
  );
  const result = await post("/v1/tools/call", {
    name: "rag_search",
    arguments: { query: "向量" },
  });
  assert.equal(result.status, 200);
  assert.equal(
    ((await result.json()) as { matches: unknown[] }).matches.length,
    1,
  );
  assert.equal((await post("/v1/search", { query: "", topK: 0 })).status, 400);
  assert.equal(
    (await post("/v1/tools/call", { name: "unknown", arguments: {} })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${url}/v1/search`, {
        method: "POST",
        headers,
        body: "bad json",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${url}/v1/search`, {
        method: "POST",
        headers: { Authorization: "Bearer test-key" },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal((await fetch(`${url}/missing`, { headers })).status, 404);
});
test("dependency errors return 502 without leaking credentials", async (t) => {
  const { rag, embedder } = fixture();
  embedder.embedQuery = async () => {
    throw new Error("provider failure secret-token");
  };
  const server = createHttpServer(rag);
  const url = await listen(server);
  t.after(() => close(server));
  const response = await fetch(`${url}/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "test" }),
  });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("secret-token"));
});

test("HTTP tool dispatch validates and authenticates document mutations with domain status codes", async (t) => {
  const { rag } = fixture();
  const server = createHttpServer(rag, { apiKey: "test-key" });
  const url = await listen(server);
  t.after(() => close(server));
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer test-key",
  };
  const call = (name: string, args: unknown, auth = true) =>
    fetch(`${url}/v1/tools/call`, {
      method: "POST",
      headers: auth ? headers : { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
  const definitions = (await (
    await fetch(`${url}/v1/tools`, { headers })
  ).json()) as { tools: { function: { name: string } }[] };
  assert.equal(definitions.tools.length, 6);
  const target = { namespace: "default", source: "http-notes.md" };
  assert.equal(
    (await call("rag_add_document", { ...target, text: "新资料" }, false))
      .status,
    401,
  );
  assert.equal((await rag.listDocuments()).totalDocuments, 0);
  assert.equal(
    (await call("rag_add_document", { source: target.source, text: "新资料" }))
      .status,
    400,
  );
  assert.equal(
    (await call("rag_add_document", { ...target, text: "新资料" })).status,
    200,
  );
  assert.equal(
    (await call("rag_add_document", { ...target, text: "误覆盖" })).status,
    409,
  );
  assert.equal(
    (
      await call("rag_update_document", {
        ...target,
        namespace: "missing",
        text: "新版本",
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("rag_update_document", { ...target, text: "新版本资料" }))
      .status,
    200,
  );
  const read = await call("rag_get_document", target);
  assert.equal(read.status, 200);
  assert.equal(
    ((await read.json()) as { chunks: { text: string }[] }).chunks[0]!.text,
    "新版本资料",
  );
  assert.equal(
    (await call("rag_delete_document", { ...target, filter: {} })).status,
    400,
  );
  assert.equal((await call("rag_delete_document", target, false)).status, 401);
  const wrongNamespace = await call("rag_delete_document", {
    ...target,
    namespace: "missing",
  });
  assert.equal(
    ((await wrongNamespace.json()) as { deleted: boolean }).deleted,
    false,
  );
  assert.equal((await rag.listDocuments()).totalDocuments, 1);
  const deleted = await call("rag_delete_document", target);
  assert.equal(
    ((await deleted.json()) as { deletedChunks: number }).deletedChunks,
    1,
  );
  assert.equal((await call("rag_get_document", target)).status, 404);
  assert.equal(
    (await call("rag_update_document", { ...target, text: "新版本" })).status,
    404,
  );
});
