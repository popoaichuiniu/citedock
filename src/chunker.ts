export type Chunk = {
  text: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
};

/** Preserve original text and line references without splitting surrogate pairs. */
export function chunkText(
  text: string,
  size: number,
  overlap: number,
): Chunk[] {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap >= size
  ) {
    throw new Error(
      "Chunk size must be positive and overlap must be smaller than size",
    );
  }
  const chars = Array.from(text.replace(/\r\n?/g, "\n"));
  const lines = [1];
  for (const char of chars)
    lines.push(lines[lines.length - 1]! + (char === "\n" ? 1 : 0));
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + size, chars.length);
    if (end < chars.length) {
      const minimumEnd = start + Math.max(Math.floor(size / 2), overlap + 1);
      for (let i = end - 1; i >= minimumEnd; i--) {
        if (/[\n。！？.!?]/u.test(chars[i]!)) {
          end = i + 1;
          break;
        }
      }
    }
    const content = chars.slice(start, end).join("");
    if (content.trim())
      chunks.push({
        text: content,
        chunkIndex: chunks.length,
        startLine: lines[start]!,
        endLine: lines[end - 1]!,
      });
    if (end === chars.length) break;
    start = end - overlap;
  }
  return chunks;
}
