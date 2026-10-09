import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

const assets = new Map([
  [
    "/",
    { file: new URL("../web/index.html", import.meta.url), type: "text/html" },
  ],
  [
    "/assets/styles.css",
    { file: new URL("../web/styles.css", import.meta.url), type: "text/css" },
  ],
  [
    "/assets/app.js",
    {
      file: new URL("../dist/web/app.js", import.meta.url),
      type: "text/javascript",
    },
  ],
  [
    "/assets/citedock.svg",
    {
      file: new URL("../web/citedock.svg", import.meta.url),
      type: "image/svg+xml",
    },
  ],
]);

export async function serveWebAsset(
  path: string,
  res: ServerResponse,
): Promise<boolean> {
  const asset = assets.get(path);
  if (!asset) return false;
  const body = await readFile(asset.file);
  res.writeHead(200, {
    "Content-Type": `${asset.type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
  return true;
}
