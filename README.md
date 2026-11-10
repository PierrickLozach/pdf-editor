# PDF Editor

A free PDF editor that runs entirely in the browser: change text in its original font, move it,
find and replace, white-out, add images and signatures, rearrange pages. PDFs never leave the device.

- `web/` — the editor (MuPDF compiled to WebAssembly, plain JavaScript, no build step needed to run it; `web/app.js` is the interface)
- `site/` — the website around it (landing page, legal pages, in 12 languages), deployed on Cloudflare
- `tools/` — build scripts (`tools/build_site.py` assembles `site/public`)

Run the editor locally: `python3 tools/serve.py 8766` then open http://127.0.0.1:8766.
Website and deployment: see [site/DEPLOY.md](site/DEPLOY.md).

## Licence

GNU Affero General Public License v3 (see `LICENSE`), because the editor is built on
[MuPDF](https://mupdf.com) © Artifex Software, Inc. Bundled fonts: Liberation, Carlito, Caladea
(SIL Open Font License) and DejaVu.

Third-party code shipped with the site: MuPDF.js (AGPL), tesseract.js and its language models (Apache-2.0),
fonts under open licences (Liberation, Carlito, Caladea, DejaVu, Dancing Script — see `web/vendor/` and `web/fonts/`).

## For developers

The engine is also a JavaScript library, for web pages and Node.js — documentation: https://pdf-editor.pierrick35.workers.dev/developers

```js
import { PDF } from "https://pdf-editor.pierrick35.workers.dev/lib/v1/pdf-editor.js";   // or: npm install github:PierrickLozach/pdf-editor
const pdf = await PDF.open(bytes);
await pdf.redact({ text: "Jane Doe" });
const out = await pdf.save();
```
