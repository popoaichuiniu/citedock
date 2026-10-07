import { createHash } from "node:crypto";
import { chunkText } from "./chunker.js";
import type { Config } from "./config.js";
import { QwenEmbedder, type Embedder } from "./embedding.js";
import {
  ingestSchema,
  searchSchema,
  type IngestInput,
  type SearchInput,
  type SearchResult,
} from "./schema.js";
import { QdrantStore, type VectorStore } from "./store.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function chunkId(documentId: string, index: number): string {
  const bytes = Buffer.from(
    digest(`${documentId}:${index}`).slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class RagService {
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: Config,
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
  ) {}

  async ingest(input: IngestInput) {
    const document = ingestSchema.parse(input);
    const documentId = digest(
      JSON.stringify([document.namespace, document.source]),
    );
    const previous = this.writes.get(documentId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const chunks = chunkText(
          document.text,
          this.config.CHUNK_SIZE,
          this.config.CHUNK_OVERLAP,
        );
        // Finish every embedding before touching existing Qdrant points.
        const vectors = await this.embedder.embedDocuments(
          chunks.map((chunk) => chunk.text),
        );
        if (vectors.length !== chunks.length)
          throw new Error("Embedding count mismatch");
        await this.store.replaceDocument(
          documentId,
          chunks.map((chunk, index) => ({
            id: chunkId(documentId, index),
            vector: vectors[index]!,
            payload: {
              ...chunk,
              documentId,
              namespace: document.namespace,
              source: document.source,
              metadata: document.metadata,
              embeddingModel: this.embedder.model,
            },
          })),
        );
        return {
          documentId,
          source: document.source,
          namespace: document.namespace,
          chunks: chunks.length,
        };
      });
    this.writes.set(documentId, operation);
    try {
      return await operation;
    } finally {
      if (this.writes.get(documentId) === operation)
        this.writes.delete(documentId);
    }
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const options = searchSchema.parse(input);
    const vector = await this.embedder.embedQuery(options.query);
    const points = await this.store.search(vector, options);
    const matches = points.map((point, index) => ({
      ...point.payload,
      id: point.id,
      score: point.score,
      citation: `[${index + 1}]`,
    }));
    const context = matches
      .map(
        (hit) =>
          `${hit.citation} ${JSON.stringify(hit.source)} (lines ${hit.startLine}-${hit.endLine})\n${hit.text}`,
      )
      .join("\n\n");
    const chars = Array.from(context);
    return {
      query: options.query,
      namespace: options.namespace,
      matches,
      context: chars.slice(0, options.maxContextChars).join(""),
      truncated: chars.length > options.maxContextChars,
    };
  }

  async health() {
    const collectionExists = await this.store.ensureCollection(false, true);
    await this.embedder.embedQuery("health check");
    return {
      status: "ok",
      collection: this.config.QDRANT_COLLECTION,
      collectionExists,
      model: this.embedder.model,
      dimensions: this.embedder.dimensions,
    };
  }
}

export function createRagService(config: Config): RagService {
  return new RagService(
    config,
    new QwenEmbedder(config),
    new QdrantStore(config),
  );
}
