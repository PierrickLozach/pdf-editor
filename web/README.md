# PDF Editor — web version

A free PDF editor that runs **entirely in the browser**: the PDF engine (MuPDF compiled to
WebAssembly) runs on the visitor's device, so documents are never uploaded anywhere. The site is
made of static files only: any web host that can serve files works, with no server code and no
database.

## Features
- **Edit text** (one tool for everything about existing text):
  - **click** a text to change it; Enter applies, Shift+Enter adds a line, Esc cancels;
  - **drag** a text to move its line: it snaps to the left/right edges, centres and baselines of
    the other lines (red guide; Alt = free, Shift = straight line); arrow keys fine-tune it
    (1 pt, Shift 10 pt, Alt 0.25 pt);
  - **drag on empty space** to select several lines (or Shift+click), then drag one of them;
  - while editing, the **move handle** (4 arrows, left of the box) moves it: the edit and the move are applied together,
    as one undo step. On a touchscreen a finger drag scrolls; use the handle to move.
  The old text is really removed. Alignment (left / centre / right) is detected automatically.
- **Fonts, with nothing to do**: each letter is drawn with the first of
  1. the PDF's own font, reused as is, for every letter the document contains;
  2. the fonts installed on the computer (Chrome / Edge, once allowed);
  3. the same free font from Google Fonts, downloaded when a PDF uses one (only its name is sent;
     can be switched off in Fonts);
  4. a look-alike with the same letter widths (Liberation, Carlito, Caladea), only for the letters
     still missing.
  The first time an edit needs a look-alike, a short note explains why the computer's fonts help;
  "Allow" redoes that edit with the real font. The Fonts window also adds Microsoft Office fonts in
  one click (the folder path is copied, the picker opens: ⌘⇧G, ⌘V, Return). Fonts are never part of
  the published site.
- Add text, white-out (removes the text it covers), images / signatures.
- Pages: rotate, duplicate, insert blank, delete, reorder by drag and drop, append another PDF.
- Undo / redo (40 steps), zoom, password-protected PDFs, phone and tablet layout.
- **Save** (Chrome/Edge: "Save as" dialog) or **Download**. The last open document is kept in the
  browser (IndexedDB) so a reload does not lose edits; "Close" removes it.

Works in current Chrome, Edge, Firefox and Safari (desktop and mobile).

## Publishing
Upload the content of this folder as-is (keep the folder structure). Requirements, met by every
static host: HTTPS, and `.wasm` files served as `application/wasm` (if not, it still works, a little
slower). It also works from a sub-folder (e.g. `https://user.github.io/pdf-editor/`).
`_headers` sets security headers on Cloudflare Pages and Netlify; elsewhere the same security
policy is in `index.html`. The only outside address the page may contact is cdn.jsdelivr.net, for
free fonts. `python3 tools/build_free_fonts.py` refreshes the free-font catalogue.

Size: about 21 MB (engine 10 MB, fonts 10 MB, loaded only when needed). Visitors download the engine
once (3.6 MB compressed); fonts are fetched one by one when an edit needs them.

## Licence
AGPL-3.0-or-later (required by MuPDF). These files are the complete source; see `LICENSE.txt`.
If you change the code and publish it, publish your changed source too (e.g. a public Git repository).

## Development (on the Mac)
- `python3 tools/build_web_app.py` regenerates `web/app.js` from the Mac version's interface
  (`static/app.js`) plus the web adaptations, then `python3 tools/stamp.py` version-stamps the files.
- `python3 tools/serve.py 8766` serves `web/` locally like a static host.
- Tests: `node tests/engine.test.mjs`, `node tests/batch.mjs ~/Desktop`,
  `cd tests/pw && node e2e.pw.mjs all && node extra.pw.mjs && node fonts.pw.mjs all` (Chromium, Firefox, WebKit).
- Everything at once: `sh tests/run-all.sh`.
