import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { documentFiles } from "./files.js";
import { createRagService } from "./rag.js";
import { MAX_PDF_BYTES } from "./schema.js";
import { executeTool, ragTools, toolCallSchema } from "./tools.js";

const usage = `CiteDock — local knowledge tools for AI agents

Usage:
  npm run rag -- ingest <file-or-directory> [--namespace default] [--source source-id]
  npm run rag -- search "question" [--namespace default] [--top-k 5] [--min-score 0.4] [--source source-id]
  npm run --silent rag -- call <tool-name> --args-file <json-file-or->
  npm run rag -- health
  npm run rag -- tools
Supported files: .md, .markdown, .txt (UTF-8), .pdf (text layer, no scanned PDFs).
Directories are imported recursively. PDF limit: 32 MiB; text file limit: 8 MiB.
call accepts an arguments object from a UTF-8 JSON file or stdin (-), up to 8 MiB.
Use tools to discover the six available tool names and argument schemas.`;

async function readArguments(path: string): Promise<unknown> {
  const maximumBytes = 8 * 1024 * 1024;
  let text: string;
  if (path === "-") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes) throw new Error("Arguments exceed 8 MiB");
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    const file = resolve(path);
    const info = await stat(file);
    if (!info.isFile()) throw new Error("--args-file must name a JSON file");
    if (info.size > maximumBytes) throw new Error("Arguments exceed 8 MiB");
    text = await readFile(file, "utf8");
    if (Buffer.byteLength(text) > maximumBytes)
      throw new Error("Arguments exceed 8 MiB");
  }
  return JSON.parse(text);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      namespace: { type: "string" },
      source: { type: "string" },
      "top-k": { type: "string" },
      "min-score": { type: "string" },
      "args-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, argument] = positionals;
  if (values["args-file"] && command !== "call")
    throw new Error("--args-file is only supported by call");
  if (values.help || !command) console.log(usage);
  else if (command === "tools")
    console.log(JSON.stringify({ tools: ragTools }, null, 2));
  else if (command === "call") {
    if (!argument || positionals.length !== 2 || !values["args-file"])
      throw new Error(usage);
    if (
      values.namespace ||
      values.source ||
      values["top-k"] ||
      values["min-score"]
    )
      throw new Error("For call, put all tool arguments in the JSON object");
    if (!ragTools.some((tool) => tool.function.name === argument))
      throw new Error(`Unknown tool: ${argument}`);
    const call = toolCallSchema.parse({
      name: argument,
      arguments: await readArguments(values["args-file"]),
    });
    const rag = createRagService(loadConfig());
    console.log(
      JSON.stringify(
        await executeTool(rag, call.name, call.arguments),
        null,
        2,
      ),
    );
  } else {
    const rag = createRagService(loadConfig());
    if (command === "ingest") {
      if (!argument || positionals.length !== 2) throw new Error(usage);
      const files = await documentFiles(resolve(argument));
      if (!files.length) throw new Error("No supported files found");
      if (values.source && files.length !== 1)
        throw new Error("--source requires a single file");
      for (const file of files) {
        const isPdf = extname(file).toLowerCase() === ".pdf";
        const maximumBytes = isPdf ? MAX_PDF_BYTES : 8 * 1024 * 1024;
        if ((await stat(file)).size > maximumBytes)
          throw new Error(
            `File exceeds ${maximumBytes / 1024 / 1024} MiB: ${file}`,
          );
        const document = {
          source: values.source ?? relative(process.cwd(), file),
          ...(values.namespace ? { namespace: values.namespace } : {}),
        };
        console.log(
          JSON.stringify(
            isPdf
              ? await rag.ingestPdf({ ...document, data: await readFile(file) })
              : await rag.ingest({
                  ...document,
                  text: await readFile(file, "utf8"),
                }),
          ),
        );
      }
    } else if (command === "search") {
      if (!argument || positionals.length !== 2) throw new Error(usage);
      console.log(
        JSON.stringify(
          await rag.search({
            query: argument,
            ...(values.namespace ? { namespace: values.namespace } : {}),
            ...(values.source ? { source: values.source } : {}),
            ...(values["top-k"] ? { topK: Number(values["top-k"]) } : {}),
            ...(values["min-score"]
              ? { minScore: Number(values["min-score"]) }
              : {}),
          }),
          null,
          2,
        ),
      );
    } else if (command === "health")
      console.log(JSON.stringify(await rag.health(), null, 2));
    else throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "RAG command failed");
  process.exitCode = 1;
}
