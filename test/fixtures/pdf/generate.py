"""Regenerate fixtures: python generate.py /path/to/a/CJK-capable/TrueType-font.ttf.

Requires reportlab, Pillow, pypdf. These are test authoring dependencies only.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter

root = Path(__file__).resolve().parent
pdfmetrics.registerFont(TTFont("FixtureCJK", sys.argv[1]))
c = canvas.Canvas(str(root / "knowledge.pdf"), pagesize=(595, 842), invariant=1)
c.setTitle("RAG PDF import fixture")
c.setFont("Helvetica", 18)
c.drawString(60, 770, "Knowledge retrieval")
c.setFont("Helvetica", 12)
c.drawString(60, 730, "Qdrant stores vectors and retrieves documents using cosine similarity.")
c.drawString(60, 706, "The TypeScript service returns source citations to the calling model.")
c.showPage()
c.showPage()  # Deliberate blank page; page 3 must keep its original number.
c.setFont("FixtureCJK", 18)
c.drawString(60, 770, "知识库向量检索")
c.setFont("FixtureCJK", 12)
c.drawString(60, 730, "Qdrant 是向量数据库，使用余弦相似度检索相关文档。")
c.drawString(60, 706, "Qwen3 Embedding 8B 生成 4096 维向量。")
c.drawString(60, 682, "PDF 导入保留原始页码，答案可以引用第三页的资料。")
c.showPage()
c.save()

image = Image.new("RGB", (700, 180), "white")
ImageDraw.Draw(image).text((20, 50), "Scanned text lives in pixels, not a PDF text layer.", fill="black")
c = canvas.Canvas(str(root / "image-only.pdf"), pagesize=(595, 842), invariant=1)
c.drawImage(ImageReader(image), 60, 610, width=475, height=122)
c.showPage()
c.save()

writer = PdfWriter()
for page in PdfReader(root / "knowledge.pdf").pages:
    writer.add_page(page)
writer.encrypt("test-password")
with (root / "encrypted.pdf").open("wb") as output:
    writer.write(output)

# A scanned page after valid text must reject the whole import, not silently skip it.
writer = PdfWriter()
writer.add_page(PdfReader(root / "knowledge.pdf").pages[0])
writer.add_page(PdfReader(root / "image-only.pdf").pages[0])
with (root / "mixed.pdf").open("wb") as output:
    writer.write(output)
