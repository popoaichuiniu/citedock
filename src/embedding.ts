import { z } from "zod";
import type { Config } from "./config.js";

const vectorSchema = z.array(z.number().finite()).min(1);
const ollamaResponse = z.object({ embeddings: z.array(vectorSchema) });
const openaiResponse = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: vectorSchema,
    }),
  ),
});
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}
export class QwenEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  constructor(private readonly config: Config) {
    this.model = config.EMBEDDING_MODEL;
    this.dimensions = config.EMBEDDING_DIMENSIONS;
  }
  async embedQuery(query: string): Promise<number[]> {
    return (
      await this.embedDocuments([
        `Instruct: ${this.config.QUERY_INSTRUCTION}\nQuery: ${query}`,
      ])
    )[0]!;
  }
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.config.EMBEDDING_BATCH_SIZE) {
      vectors.push(
        ...(await this.request(
          texts.slice(i, i + this.config.EMBEDDING_BATCH_SIZE),
        )),
      );
    }
    return vectors;
  }
  private async request(input: string[]): Promise<number[][]> {
    const isOllama = this.config.EMBEDDING_PROVIDER === "ollama";
    const url = `${this.config.EMBEDDING_BASE_URL.replace(/\/+$/, "")}/${isOllama ? "api/embed" : "embeddings"}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.EMBEDDING_API_KEY)
      headers.Authorization = `Bearer ${this.config.EMBEDDING_API_KEY}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          input,
          ...(isOllama ? { truncate: false } : { encoding_format: "float" }),
        }),
        signal: AbortSignal.timeout(this.config.EMBEDDING_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        "Embedding service unreachable or timed out; check EMBEDDING_BASE_URL and model service",
      );
    }
    if (!response.ok)
      throw new Error(
        `Embedding service returned HTTP ${response.status}; check model name, credentials, and input length`,
      );
    const json: unknown = await response.json();
    let vectors: number[][];
    if (isOllama) vectors = ollamaResponse.parse(json).embeddings;
    else {
      const data = openaiResponse
        .parse(json)
        .data.sort((a, b) => a.index - b.index);
      if (data.some((entry, index) => entry.index !== index))
        throw new Error(
          "Embedding response contains invalid or duplicate indices",
        );
      vectors = data.map((entry) => entry.embedding);
    }
    if (vectors.length !== input.length)
      throw new Error("Embedding response count does not match input count");
    return vectors.map((vector) => {
      if (vector.length < this.dimensions)
        throw new Error(
          `Embedding dimension mismatch: expected at least ${this.dimensions}, received ${vector.length}`,
        );
      // Qwen3 supports Matryoshka dimensions: truncate then normalize both queries and documents.
      const resized = vector.slice(0, this.dimensions);
      const norm = Math.hypot(...resized);
      if (!Number.isFinite(norm) || norm === 0)
        throw new Error("Embedding service returned an invalid zero vector");
      return resized.map((value) => value / norm);
    });
  }
}
