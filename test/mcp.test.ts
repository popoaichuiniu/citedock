import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { test } from "node:test";
import { createMcpServer } from "../src/mcp-server.js";
import { fixture } from "./helpers.js";

test("MCP client can discover and call rag_search with structured citations", async (t) => {
  const { rag } = fixture();
  await rag.ingest({ source: "guide.md", text: "Qdrant 存储向量" });
  const server = createMcpServer(rag);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "rag_search",
      "rag_list_documents",
      "rag_get_document",
      "rag_add_document",
      "rag_update_document",
      "rag_delete_document",
    ],
  );
  assert.equal(tools.tools[0]!.annotations?.readOnlyHint, true);
  const result = await client.callTool({
    name: "rag_search",
    arguments: { query: "向量" },
  });
  assert.ok(!result.isError);
  assert.equal(
    (result.structuredContent as { matches: { citation: string }[] })
      .matches[0]!.citation,
    "[1]",
  );
});
test("MCP dependency failures are returned as tool errors", async (t) => {
  const { rag, embedder } = fixture();
  embedder.embedQuery = async () => {
    throw new Error("Embedding offline");
  };
  const server = createMcpServer(rag);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "rag_search",
    arguments: { query: "向量" },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Embedding offline/);
});

test("MCP exposes mutation annotations and supports a complete document lifecycle", async (t) => {
  const { rag } = fixture();
  const server = createMcpServer(rag);
  const client = new Client({ name: "crud-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  assert.equal(
    tools.find((tool) => tool.name === "rag_add_document")!.annotations!
      .readOnlyHint,
    false,
  );
  for (const name of ["rag_update_document", "rag_delete_document"]) {
    assert.equal(
      tools.find((tool) => tool.name === name)!.annotations!.destructiveHint,
      true,
    );
  }
  const target = { namespace: "mcp", source: "notes.md" };
  const add = await client.callTool({
    name: "rag_add_document",
    arguments: { ...target, text: "初始资料" },
  });
  assert.ok(!add.isError);
  const duplicate = await client.callTool({
    name: "rag_add_document",
    arguments: { ...target, text: "覆盖" },
  });
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate.content), /already exists/);
  const listed = await client.callTool({
    name: "rag_list_documents",
    arguments: { namespace: target.namespace },
  });
  assert.equal(
    (listed.structuredContent as { totalDocuments: number }).totalDocuments,
    1,
  );
  const update = await client.callTool({
    name: "rag_update_document",
    arguments: { ...target, text: "完整更新资料" },
  });
  assert.ok(!update.isError);
  const read = await client.callTool({
    name: "rag_get_document",
    arguments: target,
  });
  assert.equal(
    (read.structuredContent as { chunks: { text: string }[] }).chunks[0]!.text,
    "完整更新资料",
  );
  const deletion = await client.callTool({
    name: "rag_delete_document",
    arguments: target,
  });
  assert.equal(
    (deletion.structuredContent as { deletedChunks: number }).deletedChunks,
    1,
  );
  const missing = await client.callTool({
    name: "rag_update_document",
    arguments: { ...target, text: "不存在的资料" },
  });
  assert.equal(missing.isError, true);
  assert.equal(
    (await rag.listDocuments({ namespace: target.namespace })).totalDocuments,
    0,
  );
});
