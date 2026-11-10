// The new tools, in the engine (Node): redact, split/extract, PDF -> images / text / Word,
// password protection, page numbers, watermark, PDF from pictures, OCR text layer.
// Run: node tests/tools.test.mjs   (OCR part needs tesseract.js in /tmp/pdfe-ocr, else skipped)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "../web/vendor/mupdf/mupdf.js";
import { Engine } from "../web/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");
const mk = () => new Engine({ manifest: JSON.parse(fs.readFileSync(path.join(web, "fonts", "fonts.json"), "utf8")), fetchBytes: async (s) => new Uint8Array(fs.readFileSync(path.join(web, "fonts", s.file))) });
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", n)));
const textOf = (bytes) => { const d = mupdf.Document.openDocument(bytes, "application/pdf"); let t = ""; for (let i = 0; i < d.countPages(); i++) t += d.loadPage(i).toStructuredText().asText(); return t; };

// ---------------------------------------------------------------- redact
{
  const e = mk(); e.open(fx("demo-invoice.pdf"), "d.pdf");
  const hit = e.find("Blue Harbor Consulting")[0];
  const r = await e.redact([{ page: hit.page, rect: [hit.bbox[0] - 1, hit.bbox[1] - 1, hit.bbox[2] + 1, hit.bbox[3] + 1] }]);
  const out = e.export(), raw = new TextDecoder("latin1").decode(out);
  ok(r.redacted === 1 && !e.find("Blue Harbor").length && !/Blue Harbor/.test(textOf(out)), "redact: the text is gone from the page and from the saved file");
  ok(e.find("88 Riverside Avenue").length === 1 && e.find("NORTHWIND STUDIO").length === 1, "redact: the text around it is kept");
  const pix = e.render(0, 1), [x, y] = [Math.round((hit.bbox[0] + hit.bbox[2]) / 2), Math.round((hit.bbox[1] + hit.bbox[3]) / 2)];
  const i = (y * pix.w + x) * 4;
  ok(pix.pixels[i] < 30 && pix.pixels[i + 1] < 30 && pix.pixels[i + 2] < 30, "redact: a black box is drawn where it was");
  e.undo(); ok(e.find("Blue Harbor Consulting").length === 1, "redact: undo brings it back (before saving)");
  // a photo under the box: its pixels are destroyed in the file, not just covered
  const p = mk(); p.open(fx("photo.pdf"), "p.pdf");
  await p.redact([{ page: 0, rect: [100, 200, 300, 400] }]);
  const img = (() => { const d = new mupdf.PDFDocument(p.export()); let found = null; for (let k = 1; k < d.countObjects(); k++) { const o = d.newIndirect(k); try { if (o.isStream() && o.get("Subtype").asName() === "Image") found = d.loadImage(o); } catch (e) {} } return found; })();
  const pm = img.toPixmap(), W = pm.getWidth(), H = pm.getHeight(), n = pm.getNumberOfComponents(), px = pm.getPixels().slice();
  const at = (fx_, fy) => { const xx = Math.floor(fx_ * W), yy = Math.floor(fy * H); const o = (yy * W + xx) * n; return [px[o], px[o + 1], px[o + 2]]; };
  const orig = (() => { const d = new mupdf.PDFDocument(fx("photo.pdf")); for (let k = 1; k < d.countObjects(); k++) { const o = d.newIndirect(k); try { if (o.isStream() && o.get("Subtype").asName() === "Image") { const q = d.loadImage(o).toPixmap(); return { px: q.getPixels().slice(), W: q.getWidth(), H: q.getHeight(), n: q.getNumberOfComponents() }; } } catch (e) {} } })();
  const was = (fx_, fy) => { const xx = Math.floor(fx_ * orig.W), yy = Math.floor(fy * orig.H); const o = (yy * orig.W + xx) * orig.n; return [orig.px[o], orig.px[o + 1], orig.px[o + 2]]; };
  const pts = [[150, 250], [200, 300], [280, 380], [120, 390]].map(([x, y]) => [x / 595, y / 842]);
  const nowIn = pts.map(([a, b]) => at(a, b).join()), wasIn = pts.map(([a, b]) => was(a, b).join());
  ok(new Set(nowIn).size === 1 && wasIn.every((v, k) => v !== nowIn[k]), `redact: the photo's own pixels under the box are wiped in the file, not just covered (${nowIn[0]}; were ${wasIn.slice(0, 2).join(" / ")})`);
  ok(at(450 / 595, 700 / 842).join() === was(450 / 595, 700 / 842).join(), "redact: the rest of the photo is untouched");
}
// ---------------------------------------------------------------- extract / split
{
  const e = mk(); e.open(fx("demo-invoice.pdf"), "d.pdf");
  await e.pageOp("duplicate", 0); await e.pageOp("blank", 1);
  const [a, b] = e.extract([[0], [1, 2]]);
  const da = mupdf.Document.openDocument(a, "application/pdf"), db = mupdf.Document.openDocument(b, "application/pdf");
  ok(da.countPages() === 1 && db.countPages() === 2 && /NORTHWIND/.test(textOf(a)), "split: 2 PDFs with 1 and 2 pages");
  ok(e.info().pages.length === 3, "split: the open PDF is unchanged");
}
// ---------------------------------------------------------------- convert
{
  const e = mk(); e.open(fx("demo-invoice.pdf"), "d.pdf");
  const [png] = e.toImages("png", 150), [jpg] = e.toImages("jpg", 72);
  ok(png.bytes[1] === 0x50 && png.bytes[2] === 0x4e && jpg.bytes[0] === 0xff && jpg.bytes[1] === 0xd8, `PDF → PNG / JPEG (${png.bytes.length} / ${jpg.bytes.length} bytes)`);
  const t = e.toText();
  ok(/NORTHWIND STUDIO/.test(t) && /Total due/.test(t), "PDF → text");
  const docx = e.toDocx();
  fs.writeFileSync("/tmp/pdfe-tools.docx", docx);
  ok(docx[0] === 0x50 && docx[1] === 0x4b, "PDF → Word: a .docx (zip) file");
}
// ---------------------------------------------------------------- protect
{
  const e = mk(); e.open(fx("demo-invoice.pdf"), "d.pdf");
  const out = e.protect("s3cret-pw", true, false);
  const d = mupdf.Document.openDocument(out, "application/pdf");
  ok(d.needsPassword() && !d.authenticatePassword("wrong") && d.authenticatePassword("s3cret-pw") > 0, "protect: needs the password to open (AES-256)");
  ok(!/NORTHWIND/.test(new TextDecoder("latin1").decode(out)), "protect: the content is encrypted in the file");
  let threw = ""; try { e.protect("a,b,c,d"); } catch (er) { threw = er.message; }
  ok(/comma/.test(threw), "protect: a password with a comma is refused clearly");
}
// ---------------------------------------------------------------- page numbers, watermark
{
  const e = mk(); e.open(fx("demo-invoice.pdf"), "d.pdf");
  await e.pageOp("duplicate", 0); await e.pageOp("duplicate", 0);
  await e.pageNumbers({ format: "Page {n} of {total}", position: "bottom-center" });
  ok(e.find("Page 1 of 3").length === 1 && e.find("Page 3 of 3").length === 1, "page numbers: “Page 1 of 3” … “Page 3 of 3”");
  const hit = e.find("Page 2 of 3")[0], pg = e.info().pages[1];
  ok(Math.abs((hit.bbox[0] + hit.bbox[2]) / 2 - pg.w / 2) < 3 && hit.bbox[3] > pg.h - 40, "page numbers: centred at the bottom");
  await e.watermark("CONFIDENTIAL", { opacity: 0.2 });
  ok(e.find("CONFIDENTIAL").length === 3, "watermark on every page");
  const raw = new TextDecoder("latin1").decode(e.export());
  ok(/\/ca 0\.2|\/ca \.2/.test(raw.replace(/\s+/g, " ")) || /ca 0.2/.test(raw), "watermark: semi-transparent");
  e.undo(); ok(!e.find("CONFIDENTIAL").length, "watermark: one undo step");
}
// ---------------------------------------------------------------- PDF from pictures
{
  const e = mk();
  const png = new Uint8Array(fs.readFileSync(path.join(web, "icon.png")));
  const info = e.fromImages([{ name: "a.png", bytes: png }, { name: "b.png", bytes: png }]);
  ok(info.pages.length === 2 && Math.round(info.pages[0].w) === 595, "pictures → PDF: one A4 page per picture");
  let threw = ""; try { e.fromImages([{ name: "x.txt", bytes: new TextEncoder().encode("hello") }]); } catch (er) { threw = er.message; }
  ok(/x\.txt/.test(threw), "pictures → PDF: a file that is not a picture is named in the error");
}
// ---------------------------------------------------------------- OCR text layer
{
  let tess = null;
  try { tess = await import("/tmp/pdfe-ocr/node_modules/tesseract.js/src/index.js"); } catch (e) {}
  if (!tess) console.log("  (OCR skipped: tesseract.js not installed in /tmp/pdfe-ocr)");
  else {
    // a scan: the invoice as a picture, no text
    const e = mk(); e.open(fx("demo-invoice.pdf"), "d.pdf");
    const [img] = e.toImages("png", 200);
    const scan = mk(); scan.fromImages([{ name: "scan.png", bytes: img.bytes }], { size: "fit", name: "scan.pdf" });
    ok(scan.textlessPages().length === 1 && !scan.find("Harbour").length, "OCR: the scan has no text");
    const { bytes } = scan.pagePng(0, 300);
    const worker = await tess.createWorker("eng", 1, { langPath: "/tmp/pdfe-ocr/lang", cacheMethod: "none", gzip: true });
    const r = await worker.recognize(Buffer.from(bytes), {}, { pdf: true, text: true });
    await worker.terminate();
    const before = scan.render(0, 1).pixels;
    const res = await scan.addTextLayer([{ page: 0, pdf: new Uint8Array(r.data.pdf) }]);
    ok(res.changed.length === 1, "OCR: text layer added");
    const hit = scan.find("Harbour Street");
    ok(hit.length === 1, "OCR: the scan is now searchable (“Harbour Street” found)");
    const real = e.find("Harbour Street")[0], k = scan.info().pages[0].w / e.info().pages[0].w;     // the scan page is bigger
    ok(hit[0] && hit[0].bbox.every((v, j) => Math.abs(v - real.bbox[j] * k) < 6 * k), `OCR: the text sits over the words of the picture (${hit[0] && hit[0].bbox.map(Math.round)} vs ${real.bbox.map((v) => Math.round(v * k))})`);
    const after = scan.render(0, 1).pixels;
    let diff = 0; for (let k = 0; k < before.length; k++) if (before[k] !== after[k]) diff++;
    ok(diff === 0, "OCR: nothing visible changes");
    ok(scan.pageText(0).every((s) => !s.editable), "OCR: recognised text is marked as not editable in place");
    ok(/Harbour Street/.test(textOf(scan.export())), "OCR: the saved PDF is searchable in other readers");
  }
}
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
