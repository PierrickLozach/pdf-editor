// Deleting items (engine, Node): a tilted semi-transparent watermark (one page, then every page),
// a line of normal text, and pictures; the rest of the page is untouched; one undo step each.
// Run: node tests/remove.test.mjs
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
const textOf = (bytes, p) => { const d = mupdf.Document.openDocument(bytes, "application/pdf"); return d.loadPage(p).toStructuredText().asText(); };
const words = (e, p) => e.pageText(p).filter((s) => s.editable).map((s) => s.text.trim()).join("|");
const png = new Uint8Array(fs.readFileSync(path.join(web, "icon.png")));

// a 3-page invoice with a tilted watermark (2 lines) and a logo on every page
const e = mk(); e.open(new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "demo-invoice.pdf"))), "d.pdf");
await e.pageOp("duplicate", 0); await e.pageOp("duplicate", 0);
await e.watermark("CONFIDENTIAL COPY", { opacity: 0.25 });
for (let p = 0; p < 3; p++) await e.addImage(p, [440, 700, 520, 780], png);
const before = [0, 1, 2].map((p) => words(e, p));
const wm = e.pageText(0).filter((s) => !s.editable);
ok(wm.length >= 1 && /CONFIDENTIAL/.test(wm.map((s) => s.text).join(" ")), "the watermark is tilted text (not editable in place): " + wm.map((s) => JSON.stringify(s.text.trim())).join(", "));

// similar: the stamp's lines on this page, and the same stamp on the 2 other pages
const sim = e.similarText(0, wm[0].id);
ok(sim.group.length === wm.length && sim.pages.length === 2, `similarText: ${sim.group.length} line(s) here, found on ${sim.pages.length} other pages`);

// delete it on page 1 only
const pix0 = e.render(0, 1);
let r = await e.removeText([{ page: 0, ids: sim.group }]);
ok(!e.pageText(0).some((s) => !s.editable) && !/CONFIDENTIAL/.test(textOf(e.export(), 0)), "page 1: the watermark is gone (and from the saved file)");
ok(words(e, 0) === before[0], "page 1: every other line of text is kept exactly");
ok(/CONFIDENTIAL/.test(textOf(e.export(), 1)), "page 2 still has it");
ok(e.pageImages(0).length === 1, "page 1: the logo is kept");
e.undo();
ok(e.pageText(0).some((s) => !s.editable), "undo brings it back (one step)");

// delete it on every page in one step
r = await e.removeText([{ page: 0, ids: sim.group }, ...sim.pages]);
const out = e.export();
ok([0, 1, 2].every((p) => !/CONFIDENTIAL/.test(textOf(out, p))), "every page: the watermark is gone");
ok([0, 1, 2].every((p) => words(e, p) === before[p]), "every page: the rest of the text is unchanged");
// pixels: the only change is where the watermark was (nothing else moved)
const pix1 = e.render(0, 1);
let changed = 0; for (let i = 0; i < pix0.pixels.length; i += 4) if (Math.abs(pix0.pixels[i + 1] - pix1.pixels[i + 1]) > 30) changed++;
ok(changed > 50, `the page looks different only where the watermark was (${changed} pixels changed)`);
e.undo();
ok([0, 1, 2].every((p) => e.pageText(p).some((s) => !s.editable)), "undo: back on every page in one step");

// a normal line of text
const line = e.pageText(0).find((s) => s.text.trim() === "Blue Harbor Consulting");
await e.removeText([{ page: 0, ids: [line.id] }]);
ok(!e.find("Blue Harbor Consulting").some((h) => h.page === 0) && e.find("88 Riverside Avenue").length === 3, "a level line: deleted, the line under it kept");
e.undo();

// pictures
const imgs = e.pageImages(0);
ok(imgs.length === 1 && imgs[0].bbox[0] > 430, "pageImages: the logo, at its place " + JSON.stringify(imgs[0] && imgs[0].bbox));
ok(e.similarImages(0, imgs[0].id).length === 2, "similarImages: the same logo on the 2 other pages");
await e.removeImages([{ page: 0, id: imgs[0].id }]);
ok(e.pageImages(0).length === 0 && e.pageImages(1).length === 1 && words(e, 0) === before[0], "the logo is deleted on page 1 only, the text kept");
e.undo();
await e.removeImages([{ page: 0, id: imgs[0].id }, ...e.similarImages(0, imgs[0].id).map((q) => ({ page: q, like: imgs[0] }))]);
ok([0, 1, 2].every((p) => e.pageImages(p).length === 0), "the logo is deleted on every page");
e.undo();
// a picture lying over another one: refused, nothing changed
await e.addImage(0, [460, 720, 500, 760], png);
const two = e.pageImages(0), small = two.find((x) => x.bbox[2] - x.bbox[0] < 50);
let err = ""; try { await e.removeImages([{ page: 0, id: small.id }]); } catch (x) { err = x.message; }
ok(/lies over another one/.test(err) && e.pageImages(0).length === 2, "a picture over another one: refused, both kept (" + err.slice(0, 50) + "…)");
// a photo page: its one big picture can be deleted
const ph = mk(); ph.open(new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "photo.pdf"))), "p.pdf");
const big = ph.pageImages(0);
await ph.removeImages([{ page: 0, id: big[0].id }]);
ok(ph.pageImages(0).length === 0 && /Holiday photo report/.test(textOf(ph.export(), 0)), "a page's photo: deleted, its title kept");
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
