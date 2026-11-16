// PDFs whose visible text sits in Stamp annotations (a layer drawn above the page; seen in generated
// certificates): on opening, that text becomes page text, so whiteout, redaction and text editing reach it.
// Fixture: the fictional invoice + an "APPROVED" text stamp, a sticky note, a highlight and a link.
// Run: node tests/stamps.test.mjs
import fs from "node:fs";
import * as mupdf from "../web/vendor/mupdf/mupdf.js";
import { Engine } from "../web/engine.js";
const web = new URL("../web/", import.meta.url).pathname;
const mk = () => new Engine({ manifest: JSON.parse(fs.readFileSync(web + "fonts/fonts.json", "utf8")), fetchBytes: async (s) => new Uint8Array(fs.readFileSync(web + "fonts/" + s.file)) });
const raw = new Uint8Array(fs.readFileSync(new URL("./fixtures/stamp-text.pdf", import.meta.url)));
let fails = 0; const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const px = (doc) => doc.loadPage(0).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true).getPixels();
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) n++; return n; };
const redPx = (doc, r) => { const p = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true), w = p.getWidth(), d = p.getPixels(); let n = 0;
  for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) { const i = (y * w + x) * 3; if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) n++; } return n; };
const STAMP = [300, 600, 520, 660];                              // the stamp's area, from the top-left (MuPDF and the editor)
const orig = mupdf.Document.openDocument(raw, "application/pdf");
ok(orig.loadPage(0).getAnnotations().some((a) => a.getType() === "Stamp") && !/APPROVED/.test(orig.loadPage(0).toStructuredText().asText()), "fixture: APPROVED is drawn by a Stamp annotation, not page text");
ok(redPx(orig, STAMP) > 500, "fixture: the red APPROVED is visible");

const e = mk(); e.open(raw, "stamp-text.pdf");
const pg = e.s.doc.loadPage(0);
ok(diff(px(orig), px(e.s.doc)) === 0, "opening: the page looks exactly the same");
ok(/APPROVED/.test(pg.toStructuredText().asText()), "opening: APPROVED is now page text");
const types = pg.getAnnotations().map((a) => a.getType());
ok(!types.includes("Stamp") && types.includes("Text") && types.includes("Highlight") && pg.getLinks().length === 1, "opening: the comment, the highlight and the link are kept: " + types.join(", "));
ok(!e.info().canUndo, "opening: nothing to undo, nothing changed for the user");

// whiteout over the stamp (editor coordinates: from the top)
await e.erase(0, STAMP);
ok(redPx(e.s.doc, STAMP) === 0, "whiteout: the stamp is covered");
ok(!/APPROVED/.test(e.s.doc.loadPage(0).toStructuredText().asText()), "whiteout: the stamp's text is really removed");
const saved = mupdf.Document.openDocument(e.export(), "application/pdf");
ok(!/APPROVED/.test(saved.loadPage(0).toStructuredText().asText()) && redPx(saved, STAMP) === 0, "saved file: the stamp is gone for other viewers too");

// redaction of the stamp's word
const e2 = mk(); e2.open(raw, "stamp-text.pdf");
const hits = e2.find("APPROVED", false, false);
ok(hits.length === 1, "find: the stamp's word is found (" + hits.length + ")");
// text editing: the stamp's line can be edited like any other
const line = e2.pageText(0).find((s) => /APPROVED/.test(s.text));
ok(line && line.editable, "edit text: the stamp's line is editable");

// a PDF without stamps is not touched
const inv = new Uint8Array(fs.readFileSync(new URL("./fixtures/demo-invoice.pdf", import.meta.url)));
const e3 = mk(); e3.open(inv, "demo-invoice.pdf");
const cont = (d) => { const c = d.loadPage(0).getObject().get("Contents"); return c.isArray() ? [...Array(c.length).keys()].map((i) => c.get(i).readStream().asString()).join("") : c.readStream().asString(); };
ok(cont(e3.s.doc) === cont(mupdf.Document.openDocument(inv, "application/pdf").asPDF()) && diff(px(e3.s.doc), px(mupdf.Document.openDocument(inv, "application/pdf"))) === 0, "a PDF without text stamps is opened unchanged");
console.log(fails ? `${fails} FAILED` : "ALL OK"); process.exit(fails ? 1 : 0);
