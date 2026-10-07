import { createHash } from "node:crypto";
import { chunkText, type Chunk } from "./chunker.js";
import type { Config } from "./config.js";
import { QwenEmbedder, type Embedder } from "./embedding.js";
import { extractPdf } from "./pdf.js";
import {
  ingestSchema,
  pdfIngestSchema,
  searchSchema,
  type IngestInput,
  type SearchInput,
  type SearchResult,
  type PdfIngestInput,
  documentListSchema,
  chunkListSchema,
  documentIdSchema,
  type DocumentListInput,
  type ChunkListInput,
} from "./schema.js";
import { QdrantStore, type VectorStore } from "./store.js";

type DocumentInfo = {
  namespace: string;
  source: string;
  metadata: Record<string, string | number | boolean | null>;
};
type PreparedDocument = {
  chunks: (Chunk & { page?: number })[];
  metadata: DocumentInfo["metadata"];
  pageCount?: number;
  emptyPages?: number[];
};

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
    return this.writeDocument(document, async () => ({
      chunks: chunkText(
        document.text,
        this.config.CHUNK_SIZE,
        this.config.CHUNK_OVERLAP,
      ),
      metadata: document.metadata,
    }));
  }

  async ingestPdf(input: PdfIngestInput) {
    const document = pdfIngestSchema.parse(input);
    return this.writeDocument(document, async () => {
      const pdf = await extractPdf(document.data);
      const chunks: PreparedDocument["chunks"] = [];
      for (const page of pdf.pages) {
        for (const chunk of chunkText(
          page.text,
          this.config.CHUNK_SIZE,
          this.config.CHUNK_OVERLAP,
        )) {
          chunks.push({ ...chunk, chunkIndex: chunks.length, page: page.page });
        }
      }
      return {
        chunks,
        metadata: {
          ...document.metadata,
          format: "pdf",
          pageCount: pdf.pageCount,
        },
        pageCount: pdf.pageCount,
        emptyPages: pdf.emptyPages,
      };
    });
  }

  private async writeDocument(
    document: DocumentInfo,
    prepare: () => Promise<PreparedDocument>,
  ) {
    const documentId = digest(
      JSON.stringify([document.namespace, document.source]),
    );
    const previous = this.writes.get(documentId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const prepared = await prepare();
        const { chunks } = prepared;
        const metadata = ingestSchema.shape.metadata.parse(prepared.metadata);
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
              metadata,
              embeddingModel: this.embedder.model,
            },
          })),
        );
        return {
          documentId,
          source: document.source,
          namespace: document.namespace,
          chunks: chunks.length,
          ...(prepared.pageCount !== undefined
            ? { pageCount: prepared.pageCount, emptyPages: prepared.emptyPages }
            : {}),
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
          `${hit.citation} ${JSON.stringify(hit.source)} (${hit.page ? `page ${hit.page}, ` : ""}lines ${hit.startLine}-${hit.endLine})\n${hit.text}`,
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

  async listDocuments(input: DocumentListInput = {}) {
    return this.store.listDocuments(documentListSchema.parse(input));
  }

  async listNamespaces() {
    return this.store.listNamespaces();
  }

  async listChunks(documentId: string, input: ChunkListInput = {}) {
    return this.store.listChunks(
      documentIdSchema.parse(documentId),
      chunkListSchema.parse(input),
    );
  }
}

export function createRagService(config: Config): RagService {
  return new RagService(
    config,
    new QwenEmbedder(config),
    new QdrantStore(config),
  );
}
