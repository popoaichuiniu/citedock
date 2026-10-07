import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { documentFiles } from "./files.js";
import { createRagService } from "./rag.js";
import { MAX_PDF_BYTES } from "./schema.js";
import { ragTools } from "./tools.js";

const usage = `Usage:
  npm run rag -- ingest <file-or-directory> [--namespace default] [--source source-id]
  npm run rag -- search "question" [--namespace default] [--top-k 5] [--min-score 0.4] [--source source-id]
  npm run rag -- health
  npm run rag -- tools
Supported files: .md, .markdown, .txt (UTF-8), .pdf (text layer, no scanned PDFs).
Directories are imported recursively. PDF limit: 32 MiB; text file limit: 8 MiB.`;
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      namespace: { type: "string" },
      source: { type: "string" },
      "top-k": { type: "string" },
      "min-score": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, argument] = positionals;
  if (values.help || !command) console.log(usage);
  else if (command === "tools")
    console.log(JSON.stringify({ tools: ragTools }, null, 2));
  else {
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
