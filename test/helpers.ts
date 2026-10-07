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
  DocumentListOptions,
  ChunkListOptions,
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
  async listNamespaces() {
    const counts = new Map<string, number>();
    for (const point of this.points.values())
      counts.set(
        point.payload.namespace,
        (counts.get(point.payload.namespace) ?? 0) + 1,
      );
    return {
      namespaces: [...counts].map(([namespace, chunks]) => ({
        namespace,
        chunks,
      })),
      truncated: false,
    };
  }
  async listDocuments(options: DocumentListOptions) {
    const points = [...this.points.values()].filter(
      (point) => point.payload.namespace === options.namespace,
    );
    const first = points
      .filter((point) => point.payload.chunkIndex === 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = first
      .filter((point) => !options.cursor || point.id >= options.cursor)
      .slice(0, options.limit + 1);
    return {
      namespace: options.namespace,
      totalChunks: points.length,
      totalDocuments: first.length,
      nextCursor: page[options.limit]?.id ?? null,
      documents: page.slice(0, options.limit).map(({ payload }) => ({
        documentId: payload.documentId,
        source: payload.source,
        namespace: payload.namespace,
        chunks: points.filter(
          (point) => point.payload.documentId === payload.documentId,
        ).length,
        preview: payload.text.slice(0, 180),
        ...(typeof payload.metadata.pageCount === "number"
          ? { pageCount: payload.metadata.pageCount }
          : {}),
      })),
    };
  }
  async listChunks(documentId: string, options: ChunkListOptions) {
    const points = [...this.points.values()]
      .filter(
        (point) =>
          point.payload.namespace === options.namespace &&
          point.payload.documentId === documentId,
      )
      .sort((a, b) => a.payload.chunkIndex - b.payload.chunkIndex);
    const page = points
      .filter((point) => point.payload.chunkIndex >= options.after)
      .slice(0, options.limit + 1);
    const chunks = page
      .slice(0, options.limit)
      .map((point) => ({ ...point.payload, id: point.id }));
    return {
      namespace: options.namespace,
      documentId,
      total: points.length,
      chunks,
      nextAfter:
        page.length > options.limit ? chunks.at(-1)!.chunkIndex + 1 : null,
    };
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
