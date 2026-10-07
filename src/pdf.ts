import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { MAX_PDF_BYTES, MAX_TEXT_CHARS } from "./schema.js";

const MAX_PAGES = 1000;
export class PdfImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfImportError";
  }
}
export type PdfText = {
  pages: { page: number; text: string }[];
  pageCount: number;
  emptyPages: number[];
};

/** Extract text layers only, preserving original PDF page numbers. */
export async function extractPdf(data: Uint8Array): Promise<PdfText> {
  if (!data.byteLength || data.byteLength > MAX_PDF_BYTES)
    throw new PdfImportError("PDF must contain 1 byte to 32 MiB");
  if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from("%PDF-")))
    throw new PdfImportError("无效 PDF：请导入 PDF 文件");
  // Load PDF.js only for PDF imports, keeping normal text/MCP startup lightweight.
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
  );
  const resource = (name: string) => join(root, name) + sep;
  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintInlineImageXObjectGroup,
  ]);
  const task = getDocument({
    data: new Uint8Array(data), // PDF.js can transfer ownership; preserve the caller's buffer.
    cMapUrl: resource("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: resource("standard_fonts"),
    wasmUrl: resource("wasm"),
    useWorkerFetch: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES)
      throw new PdfImportError(`PDF 超过 ${MAX_PAGES} 页，暂不支持导入`);
    const pages: PdfText["pages"] = [];
    const emptyPages: number[] = [];
    let chars = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const { items } = await page.getTextContent();
        let text = "";
        for (const item of items) {
          if (!("str" in item)) continue;
          text += item.str + (item.hasEOL ? "\n" : "");
          if (chars + text.length > MAX_TEXT_CHARS)
            throw new PdfImportError(
              `PDF 提取正文超过 ${MAX_TEXT_CHARS} 个字符`,
            );
        }
        text = text.replace(/\r\n?/g, "\n").trim();
        chars += text.length;
        if (text) pages.push({ page: number, text });
        else {
          const operators = await page.getOperatorList();
          if (operators.fnArray.some((op) => imageOps.has(op)))
            throw new PdfImportError(
              `暂不支持扫描件 PDF：第 ${number} 页仅有图像，没有文字层`,
            );
          emptyPages.push(number);
        }
      } finally {
        page.cleanup();
      }
    }
    if (!pages.length)
      throw new PdfImportError("PDF 中没有可提取的文字；暂不支持扫描件 PDF");
    return { pages, pageCount: pdf.numPages, emptyPages };
  } catch (error) {
    if (error instanceof PdfImportError) throw error;
    if (error instanceof Error && error.name === "PasswordException")
      throw new PdfImportError("暂不支持加密 PDF，请解密后导入");
    throw new PdfImportError("无法提取 PDF 正文，文件可能已损坏或格式不受支持");
  } finally {
    await task.destroy();
  }
}
