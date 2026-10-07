import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createRagService } from "./rag.js";
import { createMcpServer } from "./mcp-server.js";

try {
  const rag = createRagService(loadConfig());
  const handle = serveStdio(() => createMcpServer(rag), {
    onerror: (error) => console.error(error.message),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void handle.close();
    });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to start MCP server",
  );
  process.exitCode = 1;
}
