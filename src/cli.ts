import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createRagService } from "./rag.js";
import { searchTool } from "./tools.js";

const usage = `Usage:
  npm run rag -- ingest <file-or-directory> [--namespace default] [--source source-id]
  npm run rag -- search "question" [--namespace default] [--top-k 5] [--min-score 0.4] [--source source-id]
  npm run rag -- health
  npm run rag -- tools
Supported files: .md, .markdown, .txt (UTF-8). Directories are imported recursively.`;
async function filesAt(path: string): Promise<string[]> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    if (![".md", ".markdown", ".txt"].includes(extname(path).toLowerCase()))
      throw new Error(`Unsupported file type: ${path}`);
    return [path];
  }
  const files: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "dist", "storage"].includes(entry.name) ||
      entry.isSymbolicLink()
    )
      continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesAt(child)));
    else if (
      [".md", ".markdown", ".txt"].includes(extname(child).toLowerCase())
    )
      files.push(child);
  }
  return files;
}
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
    console.log(JSON.stringify({ tools: [searchTool] }, null, 2));
  else {
    const rag = createRagService(loadConfig());
    if (command === "ingest") {
      if (!argument || positionals.length !== 2) throw new Error(usage);
      const files = await filesAt(resolve(argument));
      if (!files.length) throw new Error("No supported files found");
      if (values.source && files.length !== 1)
        throw new Error("--source requires a single file");
      for (const file of files) {
        if ((await stat(file)).size > 8 * 1024 * 1024)
          throw new Error(`File exceeds 8 MiB: ${file}`);
        console.log(
          JSON.stringify(
            await rag.ingest({
              text: await readFile(file, "utf8"),
              source: values.source ?? relative(process.cwd(), file),
              ...(values.namespace ? { namespace: values.namespace } : {}),
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
