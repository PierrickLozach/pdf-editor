// The developer library (web/lib.js) in Node.js: every documented method, on the fictional test files.
// Run: node tests/lib.test.mjs     (the OCR part runs when tesseract.js is installed in /tmp/pdfe-ocr)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "../web/vendor/mupdf/mupdf.js";
import { PDF, PDFError, VERSION, zip } from "../web/lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, "fixtures", n));
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const textOf = (b) => { const d = mupdf.Document.openDocument(b, "application/pdf"); let t = ""; for (let i = 0; i < d.countPages(); i++) t += d.loadPage(i).toStructuredText().asText(); return t; };
const throws = async (fn, rx) => { try { await fn(); return false; } catch (e) { return e instanceof PDFError && rx.test(e.message); } };

ok(/^1\.\d+\.\d+$/.test(VERSION), "VERSION " + VERSION);
// open: Buffer, ArrayBuffer, a file path
let pdf = await PDF.open(fx("demo-invoice.pdf"));
ok(pdf.pageCount === 1 && Math.round(pdf.pages[0].width) === 595, "open a Buffer: 1 page, A4");
ok((await PDF.open(path.join(here, "fixtures", "demo-invoice.pdf"))).pageCount === 1, "open a file path (Node.js)");
ok(await throws(() => PDF.open(Buffer.from("hello")), /could not be read as a PDF/), "not a PDF: PDFError with a clear message");
// reading
ok(/NORTHWIND STUDIO/.test(await pdf.text()) && /Total due/.test(await pdf.text(0)), "text() of the document and of a page");
const hits = await pdf.find("2026");
ok(hits.length === 2 && hits[0].page === 0 && hits[0].box.length === 4, "find(): 2 places");
const lines = await pdf.lines(0);
ok(lines.length > 5 && lines.every((l) => l.id && l.box && l.font && l.size), "lines(): ids, boxes, fonts, sizes");
// editing
let r = await pdf.replaceAll("Harbour", "Lake");
ok(r.replaced === 1 && (await pdf.find("Lake Street")).length === 1 && (await pdf.find("Harbour")).length === 0, "replaceAll()");
const l = (await pdf.lines(0)).find((x) => x.text.trim() === "NORTHWIND STUDIO");
await pdf.editLine(0, l.id, "SOUTHWIND STUDIO");
ok((await pdf.find("SOUTHWIND STUDIO")).length === 1, "editLine()");
const l2 = (await pdf.lines(0)).find((x) => x.text.trim() === "Blue Harbor Consulting");
await pdf.moveLines(0, [l2.id], 0, 30);
const moved = (await pdf.find("Blue Harbor Consulting"))[0];
ok(Math.abs(moved.box[1] - l2.box[1] - 30) < 1, "moveLines() by 30 pt");
await pdf.addText(0, 60, 700, "Paid on 3 December", { size: 11, color: "#1d4ed8" });
ok((await pdf.find("Paid on 3 December")).length === 1, "addText()");
await pdf.addImage(0, [400, 680, 520, 760], fs.readFileSync(path.join(here, "..", "web", "icon.png")));
ok(/\/Subtype\s*\/Image/.test(Buffer.from(await pdf.save()).toString("latin1")), "addImage()");
pdf.undo();
ok(!/\/Subtype\s*\/Image/.test(Buffer.from(await pdf.save()).toString("latin1")) && pdf.canRedo, "undo() / canRedo");
pdf.redo();
ok(pdf.canUndo && !pdf.canRedo, "redo()");
// redact
r = await pdf.redact({ text: "2026" });
const saved = await pdf.save();
ok(r.redacted === 2 && !/2026/.test(textOf(saved)) && /SOUTHWIND/.test(textOf(saved)), "redact({text}): gone from the saved file, the rest kept");
const box = (await pdf.find("Lake Street"))[0].box;
r = await pdf.redact([{ page: 0, box: [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2] }]);
ok(r.redacted === 1 && !/Lake Street/.test(textOf(await pdf.save())) && /SOUTHWIND/.test(textOf(await pdf.save())), "redact([{page, box}])");
// pages
pdf = await PDF.open(fx("demo-invoice.pdf"));
await pdf.duplicatePage(0); await pdf.insertBlankPage(1); await pdf.rotatePage(2, 90);
ok(pdf.pageCount === 3 && pdf.pages[2].rotation === 90, "duplicatePage(), insertBlankPage(), rotatePage()");
await pdf.movePage(2, 0); await pdf.deletePage(1);
ok(pdf.pageCount === 2 && pdf.pages[0].rotation === 90, "movePage(), deletePage()");
await pdf.append(fx("demo-invoice.pdf"));
ok(pdf.pageCount === 3, "append()");
const parts = await pdf.split("1, 2-3");
ok(parts.length === 2 && mupdf.Document.openDocument(parts[1], "application/pdf").countPages() === 2 && pdf.pageCount === 3, "split(\"1, 2-3\"): 2 PDFs, document unchanged");
ok((await pdf.split([[2], [0, 1]])).length === 2, "split([[2], [0, 1]])");
ok(await throws(() => pdf.split("1-9"), /3 pages/), "split(): impossible range explained");
const z = zip(parts.map((b, i) => ({ name: `part-${i + 1}.pdf`, bytes: b })));
ok(z[0] === 0x50 && z[1] === 0x4b, "zip()");
const merged = await PDF.merge([fx("demo-invoice.pdf"), fx("demo-invoice.pdf"), fx("demo-invoice.pdf")]);
ok(merged.pageCount === 3, "PDF.merge() of 3 files");
// stamps
await merged.pageNumbers({ format: "Page {n} of {total}" });
await merged.watermark("DRAFT", { opacity: 0.2 });
ok((await merged.find("Page 3 of 3")).length === 1 && (await merged.find("DRAFT")).length === 3, "pageNumbers(), watermark()");
// size
const photo = await PDF.open(fx("photo.pdf"));
r = await photo.compress("smaller");
ok(r.after < r.before / 3, `compress(): ${Math.round(r.before / 1024)} KB → ${Math.round(r.after / 1024)} KB`);
// output
const prot = await merged.protect("secret-1234");
const pd = mupdf.Document.openDocument(prot, "application/pdf");
ok(pd.needsPassword() && pd.authenticatePassword("secret-1234") > 0, "protect(): AES-256, needs the password");
ok((await PDF.open(prot, { password: "secret-1234" })).pageCount === 3, "open({password})");
ok(await throws(() => PDF.open(prot), /protected: pass \{ password \}/) && await throws(() => PDF.open(prot, { password: "nope" }), /Wrong password/), "protected PDF: clear errors without / with a wrong password");
const imgs = await merged.toImages({ format: "jpg", dpi: 72, pages: [0] });
ok(imgs.length === 1 && imgs[0].bytes[0] === 0xff && imgs[0].bytes[1] === 0xd8, "toImages() JPEG");
const docx = await merged.toWord();
ok(docx[0] === 0x50 && docx[1] === 0x4b, "toWord()");
const px = await merged.render(0, 0.5);
ok(px.width === Math.round(595 * 0.5) && px.pixels.length === px.width * px.height * 4, "render()");
// pictures -> PDF
const fromImg = await PDF.fromImages([fs.readFileSync(path.join(here, "..", "web", "icon.png"))]);
ok(fromImg.pageCount === 1, "PDF.fromImages()");
// active content
const hostile = await PDF.open(fx("hostile.pdf"));
ok(hostile.activeContent().total > 0 && (await hostile.removeActiveContent()).removed > 0 && hostile.activeContent().total === 0, "activeContent(), removeActiveContent()");
// saved files keep the original's properties
const orig = fx("demo-invoice.pdf"), out = Buffer.from(await (await PDF.open(orig)).save());
const props = (b) => { const d = mupdf.Document.openDocument(b, "application/pdf"); return ["format", "info:Title", "info:Author", "info:Producer", "info:Creator", "info:CreationDate", "info:ModDate"].map((k) => d.getMetaData(k)).join("|"); };
ok(props(out) === props(orig) && !/Written by MuPDF/.test(out.toString("latin1")), "save(): the original's properties are kept, no trace of the editing");
// OCR (needs tesseract.js)
let tess = false;
try { await import("/tmp/pdfe-ocr/node_modules/tesseract.js/src/index.js"); tess = true; } catch (e) {}
if (!tess) console.log("  (OCR skipped: tesseract.js not installed)");
else {
  const page = (await (await PDF.open(fx("demo-invoice.pdf"))).toImages({ dpi: 200 }))[0].bytes;
  const scan = await PDF.fromImages([page], { pageSize: "fit" });
  ok((await scan.find("Harbour")).length === 0, "a scan: no text");
  const res = await scan.ocr({ languages: ["eng"] });
  ok(res.pages === 1 && (await scan.find("Harbour Street")).length === 1, "ocr(): the scan is searchable");
}
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
