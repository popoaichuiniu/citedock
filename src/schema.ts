import { z } from "zod";

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
      .max(2_000_000)
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
export const storedChunkSchema = z.object({
  documentId: z.string(),
  namespace: z.string(),
  source: z.string(),
  text: z.string(),
  chunkIndex: z.number().int(),
  startLine: z.number().int(),
  endLine: z.number().int(),
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
