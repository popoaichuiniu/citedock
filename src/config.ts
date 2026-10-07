import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const httpUrl = z
  .url()
  .refine(
    (value) => ["http:", "https:"].includes(new URL(value).protocol),
    "Use an HTTP(S) URL",
  );
const positiveInt = z.coerce.number().int().positive();
const envSchema = z
  .object({
    EMBEDDING_PROVIDER: z.enum(["ollama", "openai"]).default("ollama"),
    EMBEDDING_BASE_URL: httpUrl.default("http://127.0.0.1:11434"),
    EMBEDDING_MODEL: z.string().trim().min(1).default("qwen3-embedding:0.6b"),
    EMBEDDING_DIMENSIONS: positiveInt.max(4096).default(1024),
    EMBEDDING_BATCH_SIZE: positiveInt.max(128).default(16),
    EMBEDDING_TIMEOUT_MS: positiveInt.default(120000),
    EMBEDDING_API_KEY: z.string().default(""),
    QUERY_INSTRUCTION: z
      .string()
      .trim()
      .min(1)
      .default(
        "Given a question, retrieve relevant passages that answer the question",
      ),
    QDRANT_URL: httpUrl.default("http://127.0.0.1:6333"),
    QDRANT_API_KEY: z.string().default(""),
    QDRANT_COLLECTION: z
      .string()
      .regex(/^[\w-]+$/)
      .default("rag_qwen3_06b"),
    QDRANT_TIMEOUT_MS: positiveInt.default(30000),
    CHUNK_SIZE: positiveInt.min(32).max(16000).default(1200),
    CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),
    HTTP_HOST: z.string().min(1).default("127.0.0.1"),
    HTTP_PORT: positiveInt.max(65535).default(3000),
    RAG_API_KEY: z.string().default(""),
  })
  .superRefine((env, ctx) => {
    if (env.CHUNK_OVERLAP >= env.CHUNK_SIZE)
      ctx.addIssue({
        code: "custom",
        path: ["CHUNK_OVERLAP"],
        message: "Must be smaller than CHUNK_SIZE",
      });
    if (
      !["127.0.0.1", "localhost", "::1"].includes(env.HTTP_HOST) &&
      !env.RAG_API_KEY
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["RAG_API_KEY"],
        message: "Required when HTTP_HOST is not loopback",
      });
    }
  });
export type Config = z.infer<typeof envSchema>;
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return envSchema.parse(env);
}
export function loadConfig(): Config {
  loadDotenv({
    path: fileURLToPath(new URL("../.env", import.meta.url)),
    quiet: true,
  });
  return parseConfig(process.env);
}
