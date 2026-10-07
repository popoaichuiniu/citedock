# PDF fixtures

These are small generated test documents, not user data:

- `knowledge.pdf`: English on page 1, blank page 2, Chinese on page 3.
- `image-only.pdf`: a raster image with visible text but no text layer.
- `mixed.pdf`: one text page followed by one image-only page.
- `encrypted.pdf`: the knowledge document encrypted with the test password `test-password`.

Run `python generate.py /path/to/CJK-capable-font.ttf` to regenerate. The authoring script needs reportlab, Pillow, and pypdf; the application and tests use only TypeScript/PDF.js and do not need these Python packages.
