import { z } from "zod";

export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;

export const namespaceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .default("default");
export const searchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(8000)
      .describe("The question to retrieve evidence for"),
    namespace: namespaceSchema.describe(
      "Knowledge base namespace; defaults to default",
    ),
    topK: z.number().int().min(1).max(20).default(5),
    minScore: z.number().min(-1).max(1).optional(),
    source: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .optional()
      .describe("Exact source identifier to restrict search"),
    maxContextChars: z.number().int().min(256).max(32000).default(12000),
  })
  .strict();
export const ingestSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT_CHARS)
      .refine((value) => value.trim().length > 0, "Text must not be blank"),
    source: z.string().trim().min(1).max(2048),
    namespace: namespaceSchema,
    metadata: z
      .record(
        z.string(),
        z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
      )
      .refine(
        (value) => JSON.stringify(value).length <= 16384,
        "Metadata exceeds 16,384 characters",
      )
      .default({}),
  })
  .strict();
export type SearchInput = z.input<typeof searchSchema>;
export type IngestInput = z.input<typeof ingestSchema>;
export const documentTargetSchema = z
  .object({
    namespace: namespaceSchema
      .unwrap()
      .describe("Explicit knowledge base namespace containing the document"),
    source: ingestSchema.shape.source.describe(
      "Exact stable source identifier, as returned by rag_list_documents",
    ),
  })
  .strict();
export const documentWriteSchema = ingestSchema.extend({
  ...documentTargetSchema.shape,
  text: ingestSchema.shape.text.describe(
    "Complete document text. Updates replace the entire document, not just a passage",
  ),
  metadata: ingestSchema.shape.metadata.describe(
    "Metadata for the new document; omitted metadata becomes an empty object, including on updates",
  ),
});
export type DocumentTargetInput = z.input<typeof documentTargetSchema>;
export type DocumentWriteInput = z.input<typeof documentWriteSchema>;
export const pdfUploadSchema = ingestSchema.omit({
  text: true,
  metadata: true,
});
export const pdfIngestSchema = ingestSchema.omit({ text: true }).extend({
  data: z
    .custom<Uint8Array>(
      (value) => value instanceof Uint8Array,
      "PDF data must be a Uint8Array",
    )
    .refine(
      (data) => data.byteLength > 0 && data.byteLength <= MAX_PDF_BYTES,
      "PDF must contain 1 byte to 32 MiB",
    ),
});
export type PdfIngestInput = z.input<typeof pdfIngestSchema>;
export const storedChunkSchema = z.object({
  documentId: z.string(),
  namespace: z.string(),
  source: z.string(),
  text: z.string(),
  chunkIndex: z.number().int(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  page: z.number().int().positive().optional(),
  metadata: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
  embeddingModel: z.string(),
});
export type StoredChunk = z.infer<typeof storedChunkSchema>;
export type SearchHit = StoredChunk & {
  id: string;
  score: number;
  citation: string;
};
export type SearchResult = {
  query: string;
  namespace: string;
  matches: SearchHit[];
  context: string;
  truncated: boolean;
};

export const documentListSchema = z
  .object({
    namespace: namespaceSchema,
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export const chunkListSchema = z
  .object({
    namespace: namespaceSchema,
    limit: z.coerce.number().int().min(1).max(50).default(20),
    after: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
  })
  .strict();
export const documentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const documentReadSchema = documentTargetSchema.extend({
  limit: chunkListSchema.shape.limit,
  after: chunkListSchema.shape.after,
});
export type DocumentReadInput = z.input<typeof documentReadSchema>;
export type DocumentListInput = z.input<typeof documentListSchema>;
export type ChunkListInput = z.input<typeof chunkListSchema>;
export type DocumentSummary = {
  documentId: string;
  source: string;
  namespace: string;
  chunks: number;
  pageCount?: number;
  preview: string;
};
export type DocumentList = {
  namespace: string;
  documents: DocumentSummary[];
  totalDocuments: number;
  totalChunks: number;
  nextCursor: string | null;
};
export type ChunkList = {
  namespace: string;
  documentId: string;
  chunks: (StoredChunk & { id: string })[];
  total: number;
  nextAfter: number | null;
};
export type NamespaceList = {
  namespaces: { namespace: string; chunks: number }[];
  truncated: boolean;
};
