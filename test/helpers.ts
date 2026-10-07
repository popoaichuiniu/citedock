import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/config.js";
import type { Embedder } from "../src/embedding.js";
import { RagService } from "../src/rag.js";
import type {
  RetrievedPoint,
  SearchOptions,
  VectorPoint,
  VectorStore,
} from "../src/store.js";

export async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
export class MemoryStore implements VectorStore {
  readonly points = new Map<string, VectorPoint>();
  async ensureCollection() {
    return true;
  }
  async replaceDocument(documentId: string, points: VectorPoint[]) {
    for (const [id, point] of this.points)
      if (point.payload.documentId === documentId) this.points.delete(id);
    for (const point of points) this.points.set(point.id, point);
  }
  async search(
    _vector: number[],
    options: SearchOptions,
  ): Promise<RetrievedPoint[]> {
    return [...this.points.values()]
      .filter(
        (point) =>
          point.payload.namespace === options.namespace &&
          (!options.source || point.payload.source === options.source),
      )
      .slice(0, options.topK)
      .map((point) => ({ id: point.id, payload: point.payload, score: 0.9 }));
  }
}
export function fixture() {
  const config = parseConfig({
    EMBEDDING_DIMENSIONS: "2",
    CHUNK_SIZE: "64",
    CHUNK_OVERLAP: "8",
  });
  const embedder: Embedder = {
    model: config.EMBEDDING_MODEL,
    dimensions: 2,
    embedDocuments: async (texts) => texts.map(() => [1, 0]),
    embedQuery: async () => [1, 0],
  };
  const store = new MemoryStore();
  return {
    rag: new RagService(config, embedder, store),
    config,
    embedder,
    store,
  };
}
