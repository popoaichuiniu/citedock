import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args: string[], input = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: tmpdir(),
        // Invalid configuration proves input validation needs no live services.
        env: { ...process.env, EMBEDDING_DIMENSIONS: "invalid" },
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data) => (stdout += data));
      child.stderr.setEncoding("utf8").on("data", (data) => (stderr += data));
      child.on("error", reject);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}

test("CLI tool discovery emits JSON without loading database configuration", async () => {
  const result = await run(["tools"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    JSON.parse(result.stdout).tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    ),
    [
      "rag_search",
      "rag_list_documents",
      "rag_get_document",
      "rag_add_document",
      "rag_update_document",
      "rag_delete_document",
    ],
  );
});

test("CLI rejects unknown tools, missing arguments, and misplaced flags", async () => {
  for (const [args, expected] of [
    [["call", "arbitrary_sql", "--args-file", "-"], /Unknown tool/],
    [["call", "rag_delete_document"], /Usage:/],
    [["tools", "--args-file", "-"], /only supported by call/],
    [
      ["call", "rag_delete_document", "--args-file", "-", "--source", "x"],
      /put all tool arguments in the JSON object/,
    ],
  ] as const) {
    const result = await run([...args], "{}");
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, expected);
  }
});

test("CLI validates stdin JSON and requires explicit mutation targets", async () => {
  const malformed = await run(
    ["call", "rag_search", "--args-file", "-"],
    "{broken",
  );
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /JSON|Unexpected|property/i);
  const ambiguous = await run(
    ["call", "rag_delete_document", "--args-file", "-"],
    JSON.stringify({ source: "notes.md" }),
  );
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.stdout, "");
  assert.match(ambiguous.stderr, /namespace/);
  assert.doesNotMatch(ambiguous.stderr, /EMBEDDING_DIMENSIONS/);
});

test("CLI validates argument files and enforces the size limit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citedock-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "args.json");
  await writeFile(file, JSON.stringify({ query: "test", unexpected: true }));
  const invalid = await run(["call", "rag_search", "--args-file", file]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /unexpected/);
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  const oversized = await run(["call", "rag_search", "--args-file", file]);
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /exceed 8 MiB/);
  const oversizedStdin = await run(
    ["call", "rag_search", "--args-file", "-"],
    " ".repeat(8 * 1024 * 1024 + 1),
  );
  assert.equal(oversizedStdin.code, 1);
  assert.match(oversizedStdin.stderr, /exceed 8 MiB/);
});
