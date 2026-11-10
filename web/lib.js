/* PDF Editor library — the engine of https://pdf-editor.pierrick35.workers.dev as a JavaScript API.
 * Free software (AGPL-3.0, like MuPDF it is built on). Runs where it is called — a web page or Node.js —
 * so documents are never sent to a server.
 *
 *   import { PDF } from "https://pdf-editor.pierrick35.workers.dev/lib/v1/pdf-editor.js";   // browsers
 *   import { PDF } from "./web/lib.js";                                                      // Node.js (repository)
 *
 *   const pdf = await PDF.open(bytes);              // Uint8Array | ArrayBuffer | Blob | Node Buffer
 *   await pdf.replaceAll("2025", "2026");
 *   await pdf.redact({ text: "Jane Doe" });
 *   const out = await pdf.save();                   // Uint8Array
 *
 * Full documentation: /developers (on the site). Each method that changes the document can be undone
 * with pdf.undo(). Errors are PDFError, with a plain-language message. */
import { Engine, EditError, makeZip } from "./engine.js";

export const VERSION = "1.0.0";
export class PDFError extends Error {}
const wrap = async (fn) => {
  try { return await fn(); }
  catch (e) { if (e instanceof EditError) throw new PDFError(e.message === "PASSWORD_REQUIRED" ? "This PDF is protected: pass { password }" : e.message === "WRONG_PASSWORD" ? "Wrong password" : e.message); throw e; }
};

/* ---------------------------------------------------------------- where the library's files are */
const BASE = new URL("./", import.meta.url);
const NODE = typeof process === "object" && !!(process.versions && process.versions.node) && typeof window === "undefined";
async function readAsset(rel) {
  const u = new URL(rel, BASE);
  if (u.protocol === "file:") { const fs = await import("node:fs/promises"); return new Uint8Array(await fs.readFile(u)); }
  const r = await fetch(u);
  if (!r.ok) throw new PDFError(`Could not load ${rel} (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
async function readJSON(rel) { return JSON.parse(new TextDecoder().decode(await readAsset(rel))); }
async function toBytes(x) {
  if (x instanceof Uint8Array) return x;                                       // Node Buffer included
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (typeof Blob !== "undefined" && x instanceof Blob) return new Uint8Array(await x.arrayBuffer());
  if (typeof x === "string" && NODE) { const fs = await import("node:fs/promises"); return new Uint8Array(await fs.readFile(x)); }   // a file path
  throw new PDFError("Expected the bytes of a file (Uint8Array, ArrayBuffer, Blob" + (NODE ? ", Buffer or a file path" : "") + ")");
}

/* ---------------------------------------------------------------- fonts (bundled with the library, free ones from the font CDN) */
let manifest = null, freeCatalog = null;
const FREE_CDN = "https://cdn.jsdelivr.net/fontsource/fonts/";
async function fetchBytes(src) {
  if (src.type === "bundled") return readAsset("fonts/" + src.file);
  if (src.type === "free") {
    const r = await fetch(FREE_CDN + src.path);
    if (!r.ok) throw new PDFError("Could not download the font " + src.path);
    return new Uint8Array(await r.arrayBuffer());
  }
  if (src.type === "user" && src.bytes) return src.bytes;
  throw new PDFError("Font not available");
}
async function newEngine(opts = {}) {
  if (!manifest) manifest = await readJSON("fonts/fonts.json");
  const e = new Engine({ manifest, fetchBytes, allowFree: opts.freeFonts !== false });
  if (opts.freeFonts !== false) {
    if (!freeCatalog) freeCatalog = await readJSON("fonts/free-fonts.json").catch(() => null);
    if (freeCatalog) e.setFreeCatalog(freeCatalog);
  }
  return e;
}

/* ---------------------------------------------------------------- the document */
export class PDF {
  /** Open a PDF. options: { password, name, freeFonts: true }  (freeFonts: download free fonts of the
   *  same family as the PDF's when edited text needs letters the PDF does not contain). */
  static async open(input, options = {}) {
    const e = await newEngine(options);
    const info = await wrap(async () => e.open(await toBytes(input), options.name || "document.pdf", options.password));
    return new PDF(e, info);
  }
  /** A new PDF from pictures (JPEG, PNG, GIF, BMP, TIFF): one page per picture.
   *  options: { pageSize: "a4" (fitted, with margins) | "fit" (the picture's own size) } */
  static async fromImages(images, options = {}) {
    const e = await newEngine(options);
    const list = [];
    for (const [i, im] of [...images].entries()) list.push({ name: im.name || `image-${i + 1}`, bytes: await toBytes(im.bytes || im) });
    const info = await wrap(() => e.fromImages(list, { size: options.pageSize === "fit" ? "fit" : "a4", name: options.name || "images.pdf" }));
    return new PDF(e, info);
  }
  /** Several PDFs joined into one, in this order. */
  static async merge(inputs, options = {}) {
    const [first, ...rest] = [...inputs];
    if (!first) throw new PDFError("No PDF to merge");
    const pdf = await PDF.open(first, options);
    for (const x of rest) await pdf.append(x);
    return pdf;
  }

  constructor(engine, info) { this._e = engine; this._info = info; }
  _set(info) { if (info && info.pages) this._info = info; return info; }

  /* ---------- reading */
  /** Number of pages. */
  get pageCount() { return this._info.pages.length; }
  /** [{width, height, rotation}] in points (1/72 inch). */
  get pages() { return this._info.pages.map((p) => ({ width: p.w, height: p.h, rotation: p.rotation })); }
  /** The text of the whole document (pages separated by a form feed), or of one page (0-based). */
  async text(page) {
    if (page == null) return this._e.toText();
    return (await wrap(() => this._e.pageText(page))).map((s) => s.text).join("\n");
  }
  /** Every place a text appears: [{page, box: [x0, y0, x1, y1]}] (points, from the top-left corner). */
  async find(text, options = {}) {
    return (await wrap(() => this._e.find(text, !!options.matchCase, !!options.wholeWord))).map((h) => ({ page: h.page, box: h.bbox }));
  }
  /** The lines of text of a page, as the editor sees them: [{id, text, box, font, size, color, editable}]. */
  async lines(page) {
    return (await wrap(() => this._e.pageText(page))).map((s) => ({ id: s.id, text: s.text, box: s.tbox, font: s.font, size: s.size, color: s.color, editable: s.editable }));
  }
  /** Scripts, launch actions, unsafe links, attached files or XFA in the PDF: {total, kinds}. */
  activeContent() { return this._e.activeContent(); }

  /* ---------- editing text */
  /** Replace a text everywhere, in the same font, size and colour. -> {replaced, skipped}
   *  options: { matchCase, wholeWord, page } */
  async replaceAll(find, replacement, options = {}) {
    const r = await wrap(() => this._e.replaceAll(find, String(replacement), !!options.matchCase, !!options.wholeWord, options.page != null ? [options.page] : null));
    this._set(r);
    return { replaced: r.replaced, skipped: r.skipped };
  }
  /** Change one line (an id from lines()). options: { size, color, bold, italic, align } */
  async editLine(page, id, newText, options = {}) {
    const line = (await this.lines(page)).find((l) => l.id === id);
    if (!line) throw new PDFError("No such line on that page");
    const r = await wrap(() => this._e.editSpan(page, id, line.text, String(newText), options));
    this._set(r);
  }
  /** Move lines (ids from lines()) by dx, dy points. */
  async moveLines(page, ids, dx, dy) {
    const all = await this.lines(page);
    const items = ids.map((id) => { const l = all.find((x) => x.id === id); if (!l) throw new PDFError("No such line on that page: " + id); return { id, expected: l.text }; });
    this._set(await wrap(() => this._e.moveSpans(page, items, dx, dy)));
  }
  /** Add text. options: { size: 12, color: "#000000", bold, italic } — x, y: the start of the baseline, in points. */
  async addText(page, x, y, text, options = {}) { this._set(await wrap(() => this._e.addText(page, x, y, String(text), options))); }
  /** White out an area: the text under it is removed, the rest is painted over. Use redact() for private data. */
  async whiteout(page, box, color = "#ffffff") { this._set(await wrap(() => this._e.erase(page, box, color))); }
  /** Add a picture (JPEG, PNG… — a signature with a transparent background works) in a box, proportions kept. */
  async addImage(page, box, image, options = {}) { this._set(await wrap(async () => this._e.addImage(page, box, await toBytes(image), !!options.stretch))); }

  /* ---------- removing information for good */
  /** Redact: what is under each box is removed from the file (text, the pixels of pictures, drawings) and a
   *  black box drawn. areas: [{page, box}] and/or { text: "a word" } (every place it appears). -> {redacted} */
  async redact(what) {
    const areas = [];
    for (const w of Array.isArray(what) ? what : [what]) {
      if (w && w.text) for (const h of await this.find(w.text, w)) areas.push({ page: h.page, rect: [h.box[0] - 1, h.box[1] - 1, h.box[2] + 1, h.box[3] + 1] });
      else if (w && w.box) areas.push({ page: w.page || 0, rect: w.box });
    }
    if (!areas.length) return { redacted: 0 };
    const r = await wrap(() => this._e.redact(areas));
    this._set(r);
    return { redacted: r.redacted };
  }
  /** Remove scripts, launch actions, unsafe links, attached files, XFA. -> {removed} */
  async removeActiveContent() { const r = await this._e.removeActiveContent(); this._set(r); return { removed: r.removed.total }; }

  /* ---------- pages */
  async rotatePage(page, degrees = 90) { this._set(await wrap(() => this._e.pageOp("rotate", page, degrees))); }
  async deletePage(page) { this._set(await wrap(() => this._e.pageOp("delete", page))); }
  async movePage(page, to) { this._set(await wrap(() => this._e.pageOp("move", page, 0, to))); }
  async duplicatePage(page) { this._set(await wrap(() => this._e.pageOp("duplicate", page))); }
  async insertBlankPage(after) { this._set(await wrap(() => this._e.pageOp("blank", after))); }
  /** Add the pages of another PDF at the end. */
  async append(input) { this._set(await wrap(async () => this._e.merge(await toBytes(input)))); }
  /** New PDFs made of some pages; the document is not changed. parts: [[0, 1], [4]] (0-based) or "1-2, 5"
   *  (1-based, one PDF per range). -> [Uint8Array] */
  async split(parts) {
    if (typeof parts === "string") {
      const n = this.pageCount, out = [];
      for (const p of parts.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
        const m = /^(\d*)\s*-\s*(\d*)$/.exec(p) || /^(\d+)$/.exec(p);
        if (!m) throw new PDFError(`Not a page range: “${p}”`);
        const a = +(m[1] || 1), b = m[2] === undefined ? a : +(m[2] || n);
        if (a < 1 || b > n || a > b) throw new PDFError(`Pages ${p}: this PDF has ${n} pages`);
        out.push(Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k));
      }
      parts = out;
    }
    return wrap(() => this._e.extract(parts));
  }

  /* ---------- stamps */
  /** options: { format: "{n}" | "{n} / {total}" | "Page {n} of {total}", position: "bottom-center" | "bottom-right" |
   *  "bottom-left" | "top-right", start: 1, skipFirst: false, size: 10 } */
  async pageNumbers(options = {}) { this._set(await wrap(() => this._e.pageNumbers(options))); }
  /** options: { opacity: 0.18, color: "#c0392b" } */
  async watermark(text, options = {}) { this._set(await wrap(() => this._e.watermark(text, options))); }

  /* ---------- size, OCR */
  /** Make the PDF smaller (re-encodes large photos and scans). level: "smaller" | "smallest" -> {before, after} bytes */
  async compress(level = "smaller") { const r = await wrap(() => this._e.reduceSize(level)); this._set(r); return { before: r.before, after: r.after }; }
  /** Make scanned pages searchable. options: { languages: ["eng"] (Tesseract codes: eng fra spa por deu nld ita
   *  pol ara heb chi_sim jpn), pages: [0-based] (default: the pages without text), dpi: 300 }. -> {pages}
   *  Needs tesseract.js: loaded from this site in a browser; in Node.js install it (npm i tesseract.js). */
  async ocr(options = {}) {
    const pages = options.pages || this._e.textlessPages();
    if (!pages.length) return { pages: 0 };
    const langs = (options.languages || ["eng"]).join("+");
    let T;
    if (NODE) {
      try { T = await import("tesseract.js"); } catch (e) { throw new PDFError("OCR in Node.js needs tesseract.js: npm install tesseract.js"); }
      T = T.default || T;
    } else {
      if (!globalThis.Tesseract) await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = new URL("vendor/tesseract/tesseract.min.js", BASE).href; s.onload = res; s.onerror = () => rej(new PDFError("Could not load the text recogniser"));
        document.head.appendChild(s);
      });
      T = globalThis.Tesseract;
    }
    const root = new URL("vendor/", BASE).href;
    const opts = NODE ? { langPath: options.langPath || new URL("vendor/tessdata/", BASE).pathname, gzip: true, cacheMethod: "none" }
                      : { workerPath: root + "tesseract/worker.min.js", corePath: root + "tesseract/core/", langPath: root + "tessdata", workerBlobURL: false, gzip: true };
    const worker = await T.createWorker(langs, 1, opts);
    const layers = [];
    try {
      for (const p of pages) {
        const png = this._e.pagePng(p, options.dpi || 300);
        const img = NODE ? Buffer.from(png.bytes) : new Blob([png.bytes], { type: "image/png" });
        const r = await worker.recognize(img, {}, { pdf: true, text: false });
        if (r.data.pdf) layers.push({ page: p, pdf: new Uint8Array(r.data.pdf) });
      }
    } finally { await worker.terminate(); }
    const r = await this._e.addTextLayer(layers);
    this._set(r);
    return { pages: r.changed.length };
  }

  /* ---------- undo */
  undo() { this._set(this._e.undo()); }
  redo() { this._set(this._e.redo()); }
  get canUndo() { return this._info.canUndo; }
  get canRedo() { return this._info.canRedo; }

  /* ---------- output */
  /** The PDF: compact, fonts subset, the original's properties kept (no trace of the editing). */
  async save() { return this._e.export(); }
  /** A copy that needs a password to open (AES-256). options: { allowPrint: true, allowCopy: false } */
  async protect(password, options = {}) { return wrap(() => this._e.protect(password, options.allowPrint !== false, !!options.allowCopy)); }
  /** Pages as pictures. options: { format: "png" | "jpg", dpi: 150, pages: [0-based] } -> [{page, bytes}] */
  async toImages(options = {}) { return wrap(() => this._e.toImages(options.format === "jpg" || options.format === "jpeg" ? "jpg" : "png", options.dpi || 150, options.pages || null)); }
  /** A Word document (.docx) with the text (paragraphs, size, bold, italic; not the layout). */
  async toWord() { return this._e.toDocx(); }
  /** One page as a picture for display: {width, height, pixels: RGBA Uint8ClampedArray}. */
  async render(page, scale = 1) { const r = await wrap(() => this._e.render(page, scale)); return { width: r.w, height: r.h, pixels: r.pixels }; }
}

/** files: [{name, bytes}] -> the bytes of a .zip (no compression), e.g. for the result of split(). */
export function zip(files) { return makeZip(files); }
