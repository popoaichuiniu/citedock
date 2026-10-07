import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import type { Config } from "./config.js";
import {
  storedChunkSchema,
  type StoredChunk,
  type DocumentList,
  type ChunkList,
  type NamespaceList,
  type documentListSchema,
  type chunkListSchema,
} from "./schema.js";
import type { z } from "zod";

export type DocumentListOptions = z.output<typeof documentListSchema>;
export type ChunkListOptions = z.output<typeof chunkListSchema>;

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
  listDocuments(options: DocumentListOptions): Promise<DocumentList>;
  listChunks(documentId: string, options: ChunkListOptions): Promise<ChunkList>;
  listNamespaces(): Promise<NamespaceList>;
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
      // Debugger pauses can leave an idle pooled connection closed by Qdrant.
      ...(!config.QDRANT_KEEP_ALIVE
        ? { headers: { Connection: "close" } }
        : {}),
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

  async listDocuments(options: DocumentListOptions): Promise<DocumentList> {
    const empty: DocumentList = {
      namespace: options.namespace,
      documents: [],
      totalDocuments: 0,
      totalChunks: 0,
      nextCursor: null,
    };
    if (!(await this.ensureCollection(false))) return empty;
    const collection = this.config.QDRANT_COLLECTION;
    const namespace = { key: "namespace", match: { value: options.namespace } };
    const filter = {
      must: [namespace, { key: "chunkIndex", match: { value: 0 } }],
    };
    const [page, documents, chunks] = await Promise.all([
      this.client.scroll(collection, {
        filter,
        limit: options.limit,
        ...(options.cursor ? { offset: options.cursor } : {}),
        with_payload: true,
        with_vector: false,
      }),
      this.client.count(collection, { filter, exact: true }),
      this.client.count(collection, {
        filter: { must: [namespace] },
        exact: true,
      }),
    ]);
    const summaries = await Promise.all(
      page.points.map(async (point) => {
        const payload = storedChunkSchema.parse(point.payload);
        const { count } = await this.client.count(collection, {
          filter: {
            must: [
              namespace,
              { key: "documentId", match: { value: payload.documentId } },
            ],
          },
          exact: true,
        });
        const pageCount = payload.metadata.pageCount;
        return {
          documentId: payload.documentId,
          source: payload.source,
          namespace: payload.namespace,
          chunks: count,
          ...(typeof pageCount === "number" ? { pageCount } : {}),
          preview: Array.from(payload.text).slice(0, 180).join(""),
        };
      }),
    );
    return {
      ...empty,
      documents: summaries,
      totalDocuments: documents.count,
      totalChunks: chunks.count,
      nextCursor:
        page.next_page_offset == null ? null : String(page.next_page_offset),
    };
  }

  async listNamespaces(): Promise<NamespaceList> {
    if (!(await this.ensureCollection(false)))
      return { namespaces: [], truncated: false };
    const result = await this.client.facet(this.config.QDRANT_COLLECTION, {
      key: "namespace",
      limit: 1001,
      exact: true,
    });
    return {
      namespaces: result.hits
        .slice(0, 1000)
        .map((hit) => ({ namespace: String(hit.value), chunks: hit.count }))
        .sort((a, b) => a.namespace.localeCompare(b.namespace)),
      truncated: result.hits.length > 1000,
    };
  }

  async listChunks(
    documentId: string,
    options: ChunkListOptions,
  ): Promise<ChunkList> {
    const empty: ChunkList = {
      namespace: options.namespace,
      documentId,
      chunks: [],
      total: 0,
      nextAfter: null,
    };
    if (!(await this.ensureCollection(false))) return empty;
    const collection = this.config.QDRANT_COLLECTION;
    const must = [
      { key: "namespace", match: { value: options.namespace } },
      { key: "documentId", match: { value: documentId } },
    ];
    const [page, count] = await Promise.all([
      this.client.scroll(collection, {
        filter: {
          must: [...must, { key: "chunkIndex", range: { gte: options.after } }],
        },
        order_by: { key: "chunkIndex", direction: "asc" },
        limit: options.limit + 1,
        with_payload: true,
        with_vector: false,
      }),
      this.client.count(collection, { filter: { must }, exact: true }),
    ]);
    const chunks = page.points
      .slice(0, options.limit)
      .map((point) => ({
        ...storedChunkSchema.parse(point.payload),
        id: String(point.id),
      }));
    return {
      ...empty,
      chunks,
      total: count.count,
      nextAfter:
        page.points.length > options.limit
          ? chunks.at(-1)!.chunkIndex + 1
          : null,
    };
  }
}
