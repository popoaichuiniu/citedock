import { loadConfig } from "./config.js";
import { createRagService } from "./rag.js";
import { createHttpServer } from "./http-server.js";

try {
  const config = loadConfig();
  const server = createHttpServer(createRagService(config), {
    apiKey: config.RAG_API_KEY,
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(config.HTTP_PORT, config.HTTP_HOST, () =>
    console.error(
      `RAG HTTP API listening on http://${config.HTTP_HOST}:${config.HTTP_PORT}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 10000).unref();
    });
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Failed to start HTTP server",
  );
  process.exitCode = 1;
}
