import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import type { Config } from "./config.js";
import { storedChunkSchema, type StoredChunk } from "./schema.js";

export type VectorPoint = {
  id: string;
  vector: number[];
  payload: StoredChunk;
};
export type RetrievedPoint = {
  id: string;
  score: number;
  payload: StoredChunk;
};
export type SearchOptions = {
  namespace: string;
  topK: number;
  source?: string | undefined;
  minScore?: number | undefined;
};
export interface VectorStore {
  ensureCollection(create: boolean, refresh?: boolean): Promise<boolean>;
  replaceDocument(documentId: string, points: VectorPoint[]): Promise<void>;
  search(vector: number[], options: SearchOptions): Promise<RetrievedPoint[]>;
}

export class QdrantStore implements VectorStore {
  readonly client: QdrantClient;
  private ready: Promise<boolean> | undefined;
  constructor(private readonly config: Config) {
    this.client = new QdrantClient({
      url: config.QDRANT_URL,
      ...(config.QDRANT_API_KEY ? { apiKey: config.QDRANT_API_KEY } : {}),
      timeout: config.QDRANT_TIMEOUT_MS,
      checkCompatibility: false,
    });
  }

  async ensureCollection(create: boolean, refresh = false): Promise<boolean> {
    if (this.ready && !refresh) {
      const exists = await this.ready;
      if (exists || !create) return exists;
    }
    const operation = this.initialize(create);
    this.ready = operation;
    try {
      const exists = await operation;
      if (!exists && this.ready === operation) this.ready = undefined;
      return exists;
    } catch (error) {
      if (this.ready === operation) this.ready = undefined;
      throw error;
    }
  }

  private async initialize(create: boolean): Promise<boolean> {
    const collection = this.config.QDRANT_COLLECTION;
    const { exists } = await this.client.collectionExists(collection);
    if (!exists && !create) return false;
    if (!exists) {
      try {
        await this.client.createCollection(collection, {
          vectors: {
            size: this.config.EMBEDDING_DIMENSIONS,
            distance: "Cosine",
          },
          metadata: {
            ragSchemaVersion: 1,
            embeddingModel: this.config.EMBEDDING_MODEL,
            embeddingProvider: this.config.EMBEDDING_PROVIDER,
          },
        });
      } catch (error) {
        // Another process may create the collection between the read and write.
        if (!(await this.client.collectionExists(collection)).exists)
          throw error;
      }
    }
    const info = await this.client.getCollection(collection);
    const vectors = info.config.params.vectors;
    const metadata = info.config.metadata;
    if (
      !vectors ||
      !("size" in vectors) ||
      vectors.size !== this.config.EMBEDDING_DIMENSIONS ||
      vectors.distance !== "Cosine"
    ) {
      throw new Error(
        "Qdrant vector size/distance mismatch; use a new QDRANT_COLLECTION for this embedding configuration",
      );
    }
    if (
      metadata?.ragSchemaVersion !== 1 ||
      metadata.embeddingModel !== this.config.EMBEDDING_MODEL ||
      metadata.embeddingProvider !== this.config.EMBEDDING_PROVIDER
    ) {
      throw new Error(
        "Qdrant collection embedding model/provider or schema mismatch; use a new QDRANT_COLLECTION",
      );
    }
    if (create) {
      for (const [field_name, field_schema] of [
        ["namespace", "keyword"],
        ["source", "keyword"],
        ["documentId", "keyword"],
        ["chunkIndex", "integer"],
      ] as const) {
        await this.client.createPayloadIndex(collection, {
          field_name,
          field_schema,
          wait: true,
        });
      }
    }
    return true;
  }

  async replaceDocument(
    documentId: string,
    points: VectorPoint[],
  ): Promise<void> {
    if (!points.length)
      throw new Error("Cannot replace a document with no chunks");
    await this.ensureCollection(true);
    // Keep requests below Qdrant's payload limit, even for 4096-dimensional vectors.
    for (let offset = 0; offset < points.length; offset += 64) {
      await this.client.upsert(this.config.QDRANT_COLLECTION, {
        wait: true,
        points: points.slice(offset, offset + 64),
      });
    }
    // Stable chunk IDs replace existing chunks. Remove the tail only AFTER successful upsert.
    await this.client.delete(this.config.QDRANT_COLLECTION, {
      wait: true,
      filter: {
        must: [
          { key: "documentId", match: { value: documentId } },
          { key: "chunkIndex", range: { gte: points.length } },
        ],
      },
    });
  }

  async search(
    vector: number[],
    options: SearchOptions,
  ): Promise<RetrievedPoint[]> {
    if (!(await this.ensureCollection(false))) return [];
    const must: Schemas["Condition"][] = [
      { key: "namespace", match: { value: options.namespace } },
    ];
    if (options.source)
      must.push({ key: "source", match: { value: options.source } });
    const result = await this.client.query(this.config.QDRANT_COLLECTION, {
      query: vector,
      limit: options.topK,
      with_payload: true,
      with_vector: false,
      filter: { must },
      ...(options.minScore !== undefined
        ? { score_threshold: options.minScore }
        : {}),
    });
    return result.points.map((point) => ({
      id: String(point.id),
      score: point.score,
      payload: storedChunkSchema.parse(point.payload),
    }));
  }
}
