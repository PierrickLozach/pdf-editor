// Tick boxes drawn as text and moving a picture (engine, Node).
// Tick boxes: an empty box is ticked with its own font's ticked twin (☐ -> ☑), a ticked box unticked,
// a mark typed over a box (a filler's ✔) removed; a Wingdings box whose subset has no ticked twin gets
// a ✓ written over it (only when Microsoft Office's Wingdings is on this computer: never published).
// Pictures: a transparent signature is moved and resized, stays transparent, one undo step, one
// picture in the saved file. Run: node tests/ticks.test.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as mupdf from "../web/vendor/mupdf/mupdf.js";
import { Engine } from "../web/engine.js";
import { signaturePng } from "./fixtures/make-signature-png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");
const mk = () => new Engine({ manifest: JSON.parse(fs.readFileSync(path.join(web, "fonts", "fonts.json"), "utf8")), fetchBytes: async (s) => new Uint8Array(fs.readFileSync(path.join(web, "fonts", s.file))) });
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
const fixture = new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "ticks-signature.pdf")));

/** The tick box left of a label, with its state. */
function box(e, p, label) {
  const sp = e.pageText(p), w = sp.find((s) => s.text.includes(label));
  const b = sp.filter((s) => (s.box === "empty" || s.box === "checked") && Math.abs(s.tbox[1] - w.tbox[1]) < 4 && s.tbox[2] <= w.tbox[0] + 3)
    .sort((a, c) => c.tbox[2] - a.tbox[2])[0];
  return b && { ...b, state: b.box, marks: sp.filter((s) => s.box === "mark" && s.tbox[0] >= b.tbox[0] - 1 && s.tbox[2] <= b.tbox[2] + 1 && s.tbox[1] >= b.tbox[1] - 1 && s.tbox[3] <= b.tbox[3] + 1) };
}
const labels = (e, p) => e.pageText(p).filter((s) => !s.box).map((s) => s.text.trim()).join("|");

/* ---------------------------------------------------------------- tick boxes */
{
  const e = mk(); e.open(fixture, "t.pdf");
  const before = labels(e, 0);
  ok(box(e, 0, "Option A").state === "empty" && box(e, 0, "Option B").state === "checked", "an empty ☐ and a ticked ☑ are recognised");
  const c = box(e, 0, "Option C");
  ok(c.state === "checked" && c.marks.length === 1, "a box with a mark typed over it counts as ticked");

  let r = await e.toggleCheck(0, box(e, 0, "Option A").id);
  let a = box(e, 0, "Option A");
  ok(r.checked && a.state === "checked" && a.text.trim() === "☑", `click on an empty box ticks it (${JSON.stringify(a.text.trim())}, font ${r.font})`);
  ok(r.fontKind === "exact", "written with the PDF's own font");
  ok(Math.abs(a.tbox[0] - 50) < 0.6, "the box stays where it was");
  ok(labels(e, 0) === before, "the rest of the page is untouched");
  e.undo();
  ok(box(e, 0, "Option A").state === "empty", "one undo step unticks it again");

  r = await e.toggleCheck(0, box(e, 0, "Option B").id);
  ok(!r.checked && box(e, 0, "Option B").state === "empty" && box(e, 0, "Option B").text.trim() === "☐", "click on a ticked box unticks it");

  r = await e.toggleCheck(0, c.marks[0].id);                       // a click on the mark itself
  const c2 = box(e, 0, "Option C");
  ok(!r.checked && c2.state === "empty" && !c2.marks.length && c2.text.trim() === "☐", "click on a box with a mark: the mark goes, the box stays");
  r = await e.toggleCheck(0, c2.id);
  ok(r.checked && box(e, 0, "Option C").state === "checked", "…and a click ticks it again");
  ok(labels(e, 0) === before, "labels untouched after all of it");
  const saved = mupdf.Document.openDocument(e.export(), "application/pdf").loadPage(0).toStructuredText().asText();
  ok(/☑/.test(saved) && /Option A/.test(saved), "the saved PDF has the ticks");
}

/* ---------------------------------------------------------------- Wingdings without its ticked twin (local only) */
const WING = "/Applications/Microsoft Word.app/Contents/Resources/DFonts/Wingdings.ttf";
const PY = path.join(here, "..", ".venv", "bin", "python");
if (fs.existsSync(WING) && fs.existsSync(PY)) {
  const out = "/tmp/pdfe-ticks-wingdings.pdf";
  execFileSync(PY, ["-W", "ignore", "-c", `
import pymupdf as fitz
d=fitz.open(); p=d.new_page(width=300,height=200)
p.insert_text((40,60),chr(0xF0A8),fontsize=10,fontname='wing',fontfile=${JSON.stringify(WING)})
p.insert_text((56,60),'Accept',fontsize=10,fontname='helv')
d.subset_fonts(); d.save(${JSON.stringify(out)},garbage=4,deflate=True)`]);
  const e = mk(); e.open(new Uint8Array(fs.readFileSync(out)), "w.pdf");
  const b = box(e, 0, "Accept");
  ok(b && b.state === "empty", "Wingdings empty box recognised: " + JSON.stringify(b && b.text));
  const r = await e.toggleCheck(0, b.id);
  const b2 = box(e, 0, "Accept");
  ok(r.checked && b2.state === "checked" && b2.marks.length === 1 && b2.marks[0].text.trim() === "✓", "its subset has no ☑: a ✓ is written inside the box");
  const m = b2.marks[0];
  ok(m.tbox[0] >= b2.tbox[0] - 0.5 && m.tbox[2] <= b2.tbox[2] + 0.5, "the ✓ fits inside the box");
  await e.toggleCheck(0, m.id);
  ok(box(e, 0, "Accept").state === "empty" && !box(e, 0, "Accept").marks.length, "a click removes the ✓ again");
} else console.log("  SKIPPED Wingdings check (needs Microsoft Office's Wingdings.ttf and .venv)");

/* ---------------------------------------------------------------- moving and resizing a picture */
{
  const e = mk(); e.open(fixture, "t.pdf");
  await e.addImage(0, [330, 400, 530, 470], signaturePng(), true);    // signed like the Sign tool does
  const before = labels(e, 0);
  const [im] = e.pageImages(0);
  ok(im && Math.abs(im.bbox[0] - 330) < 0.5 && Math.abs(im.bbox[3] - 470) < 0.5, "the signature picture is at [330,400,530,470]");
  const to = [320, 320, 470, 372.5];                                 // moved into the box, 3/4 of its size
  const r = await e.moveImage(0, im.id, to, { w: im.w, h: im.h, bbox: im.bbox });
  const now = e.pageImages(0);
  ok(now.length === 1 && now[0].bbox.every((v, k) => Math.abs(v - to[k]) < 0.5), "moved and resized: " + JSON.stringify(now[0] && now[0].bbox));
  ok(r.id === now[0].id && r.bbox.every((v, k) => Math.abs(v - to[k]) < 0.01), "the answer says where it is now");
  ok(labels(e, 0) === before, "the text of the page is untouched");
  const renders = new Map();
  const pix = (bytes, x, y) => {
    let r = renders.get(bytes);
    if (!r) {
      const pm = mupdf.Document.openDocument(bytes, "application/pdf").loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
      r = { px: pm.getPixels().slice(), w: pm.getWidth() }; renders.set(bytes, r);
    }
    const i = (Math.round(y) * r.w + Math.round(x)) * 3;
    return [r.px[i], r.px[i + 1], r.px[i + 2]];
  };
  const out = e.export().slice();
  const ink = (c) => c[0] < 120 && c[2] < 160;
  const inkIn = (bytes, b) => { let n = 0; for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) if (ink(pix(bytes, x, y))) n++; return n; };
  ok(inkIn(out, [320, 320, 470, 373]) > 100, "the signature is drawn at its new place");
  // upright, not mirrored: its highest peak (260,20 of 400x140) is near the top of the new box
  const at = (b, px, py) => [b[0] + px / 400 * (b[2] - b[0]), b[1] + py / 140 * (b[3] - b[1])];
  const near = (bytes, [x, y]) => inkIn(bytes, [Math.round(x) - 2, Math.round(y) - 2, Math.round(x) + 3, Math.round(y) + 3]);
  ok(near(out, at(to, 260, 20)) > 0 && near(out, at(to, 260, 120)) === 0, "still upright after the move (not flipped)");
  e.undo(); const signed = e.export().slice(); e.redo();
  ok(inkIn(signed, [330, 400, 530, 470]) > 100 && inkIn(out, [330, 400, 530, 470]) === 0, "nothing left at its old place");
  ok(pix(out, 322, 322).every((v) => v > 240) && pix(signed, 332, 402).every((v) => v > 240), "still transparent (the page shows through its empty corner): " + pix(out, 322, 322) + " / before " + pix(signed, 332, 402));
  const saved = mupdf.Document.openDocument(out, "application/pdf");
  let n = 0; const dev = new mupdf.Device({ fillImage() { n++; } }); saved.loadPage(0).run(dev, mupdf.Matrix.identity); dev.close();
  ok(n === 1, "the saved PDF draws the picture once");
  // moved again (and again): never flips
  let cur = e.pageImages(0)[0];
  for (const b of [[100, 600, 250, 652.5], [200, 650, 350, 702.5]]) {
    const r2 = await e.moveImage(0, cur.id, b, { w: cur.w, h: cur.h, bbox: cur.bbox });
    cur = { id: r2.id, bbox: r2.bbox, w: cur.w, h: cur.h };
  }
  const out2 = e.export().slice();
  ok(near(out2, at([200, 650, 350, 702.5], 260, 20)) > 0 && near(out2, at([200, 650, 350, 702.5], 260, 120)) === 0, "still upright after three moves");
  e.undo(); e.undo();
  let threw = false;
  try { await e.moveImage(0, now[0].id, [0, 0, 10, 10], { w: im.w, h: im.h, bbox: im.bbox }); } catch (err) { threw = /changed/.test(err.message); }
  ok(threw, "a stale picture box is refused (the page changed)");
  e.undo();
  const back = e.pageImages(0);
  ok(back.length === 1 && back[0].bbox.every((v, k) => Math.abs(v - im.bbox[k]) < 0.5), "one undo step puts it back");
}

console.log(fails ? `${fails} FAILED` : "all tick box and picture checks passed");
process.exit(fails ? 1 : 0);
