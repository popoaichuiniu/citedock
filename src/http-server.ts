import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import type { RagService } from "./rag.js";
import { PdfImportError } from "./pdf.js";
import {
  ingestSchema,
  searchSchema,
  pdfUploadSchema,
  MAX_PDF_BYTES,
} from "./schema.js";
import { executeTool, searchTool } from "./tools.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const toolCallSchema = z
  .object({ name: z.literal("rag_search"), arguments: searchSchema })
  .strict();
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
function authorized(header: string | undefined, apiKey: string): boolean {
  if (!apiKey) return true;
  if (!header?.startsWith("Bearer ")) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(apiKey));
}
async function readBody(
  req: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const limitError = () =>
    new HttpError(
      413,
      `Request body exceeds ${maximumBytes / 1024 / 1024} MiB`,
    );
  if (Number(req.headers["content-length"]) > maximumBytes) {
    req.resume();
    throw limitError();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const data of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      req.resume();
      throw limitError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function requireContentType(req: IncomingMessage, expected: string) {
  if (
    req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    expected
  )
    throw new HttpError(415, `Use Content-Type: ${expected}`);
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  requireContentType(req, "application/json");
  const bytes = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new HttpError(
      400,
      JSON.stringify(
        parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      ),
    );
  return parsed.data;
}

export function createHttpServer(
  rag: RagService,
  options: { apiKey?: string } = {},
) {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz")
        return send(res, 200, { status: "ok" });
      if (!authorized(req.headers.authorization, options.apiKey ?? "")) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return send(res, 401, { error: "Unauthorized" });
      }
      if (req.method === "GET" && path === "/readyz")
        return send(res, 200, await rag.health());
      if (req.method === "GET" && path === "/v1/tools")
        return send(res, 200, { tools: [searchTool] });
      if (req.method === "POST" && path === "/v1/search")
        return send(
          res,
          200,
          await rag.search(validate(searchSchema, await readJson(req))),
        );
      if (req.method === "POST" && path === "/v1/documents")
        return send(
          res,
          200,
          await rag.ingest(validate(ingestSchema, await readJson(req))),
        );
      if (req.method === "POST" && path === "/v1/documents/pdf") {
        const document = validate(
          pdfUploadSchema,
          Object.fromEntries(url.searchParams),
        );
        requireContentType(req, "application/pdf");
        const data = await readBody(req, MAX_PDF_BYTES);
        if (!data.length) throw new HttpError(400, "PDF 请求正文不能为空");
        return send(res, 200, await rag.ingestPdf({ ...document, data }));
      }
      if (req.method === "POST" && path === "/v1/tools/call") {
        const call = validate(toolCallSchema, await readJson(req));
        return send(
          res,
          200,
          await executeTool(rag, call.name, call.arguments),
        );
      }
      return send(res, 404, { error: "Route not found" });
    })().catch((error: unknown) => {
      if (res.destroyed || res.headersSent) return;
      if (error instanceof HttpError)
        return send(res, error.status, { error: error.message });
      if (error instanceof PdfImportError)
        return send(res, 400, { error: error.message });
      console.error(
        "RAG request failed:",
        error instanceof Error ? error.message : "Unknown dependency failure",
      );
      send(res, 502, {
        error:
          "RAG dependency failed; check Qdrant, embedding configuration, and server logs",
      });
    });
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  return server;
}
