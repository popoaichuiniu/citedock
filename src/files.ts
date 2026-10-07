import { readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const extensions = new Set([".md", ".markdown", ".txt", ".pdf"]);

/** Discover supported documents without following directory symlinks. */
export async function documentFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (!info.isDirectory()) {
    if (!info.isFile() || !extensions.has(extname(path).toLowerCase()))
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
    if (entry.isDirectory()) files.push(...(await documentFiles(child)));
    else if (entry.isFile() && extensions.has(extname(child).toLowerCase()))
      files.push(child);
  }
  return files;
}
