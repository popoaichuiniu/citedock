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
    ["rag_search"],
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
