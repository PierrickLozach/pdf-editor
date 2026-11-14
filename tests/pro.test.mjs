// Pro features in the engine (Node): smart redaction (finding personal data), forms (add, fill,
// saved and reopened), comparing two PDFs. Fictional data only.
// Run: node tests/pro.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "../web/vendor/mupdf/mupdf.js";
import { Engine } from "../web/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url)), web = path.join(here, "..", "web");
const mk = () => new Engine({ manifest: JSON.parse(fs.readFileSync(path.join(web, "fonts", "fonts.json"), "utf8")), fetchBytes: async (s) => new Uint8Array(fs.readFileSync(path.join(web, "fonts", s.file))) });
const invoice = new Uint8Array(fs.readFileSync(path.join(here, "fixtures", "demo-invoice.pdf")));
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fails++; };
// a valid French social security number (fictional): key = 97 - (13 digits mod 97)
const nir13 = "1850578006084", nir = nir13 + String(97 - Number(BigInt(nir13) % 97n)).padStart(2, "0");
const nirSpaced = `${nir[0]} ${nir.slice(1, 3)} ${nir.slice(3, 5)} ${nir.slice(5, 7)} ${nir.slice(7, 10)} ${nir.slice(10, 13)} ${nir.slice(13)}`;

// ---------------------------------------------------------------- smart redaction
const e = mk(); e.open(invoice, "d.pdf");
const lines = ["Contact: jane.doe@example.com", "Phone: +33 6 12 34 56 78", "IBAN: FR14 2004 1010 0505 0001 3M02 606", "Card: 4111 1111 1111 1111",
  "Social security: " + nirSpaced, "Not personal: 2026-04-12, 1 280,00 EUR, ref 12345", "Bad IBAN: FR00 1234 5678 9012 3456 7890 123", "Bad card: 4111 1111 1111 1112"];
for (const [i, l] of lines.entries()) await e.addText(0, 60, 560 + i * 18, l, { size: 10 });
const hits = e.findPersonal();
const kinds = hits.map((h) => h.kind + ":" + h.text);
ok(hits.some((h) => h.kind === "email" && h.text === "jane.doe@example.com"), "email found");
ok(hits.some((h) => h.kind === "phone" && /6 12 34 56 78/.test(h.text)), "phone number found");
ok(hits.some((h) => h.kind === "iban" && /FR14/.test(h.text)), "valid IBAN found");
ok(hits.some((h) => h.kind === "card" && /4111 1111 1111 1111/.test(h.text)), "valid card number found");
ok(hits.some((h) => h.kind === "nir" && h.text.replace(/\s/g, "") === nir), "valid social security number found");
ok(!hits.some((h) => /FR00|1112|2026-04-12|1 280|12345/.test(h.text)), "nothing found in dates, amounts, references, invalid IBAN or card: " + kinds.filter((k) => /FR00|1112|2026|1 280|12345/.test(k)).join(" | "));
ok(hits.every((h) => h.bbox[2] > h.bbox[0] && h.bbox[3] > h.bbox[1]), "each one has its place on the page");
ok(e.findPersonal(["email"]).length === 1, "only the kinds asked for");
// redact them all: gone from the saved file
await e.redact(hits.map((h) => ({ page: h.page, rect: h.bbox })));
const txt = mupdf.Document.openDocument(e.export(), "application/pdf").loadPage(0).toStructuredText().asText();
ok(!/jane\.doe|12 34 56|FR14|4111 1111 1111 1111/.test(txt) && /Not personal/.test(txt), "redacted for good, the rest kept");

// ---------------------------------------------------------------- forms
const f = mk(); f.open(invoice, "f.pdf");
ok(f.hasForm() === false, "no form at first");
let r = await f.addField(0, [300, 600, 520, 622], "text", "Your name");
ok(r.name === "Your_name" && f.formFields(0).length === 1, "a text field is added: " + r.name);
await f.addField(0, [300, 640, 316, 656], "checkbox", "Agree");
const fl = f.formFields(0);
ok(fl.length === 2 && fl.some((x) => x.type === "checkbox" && !x.checked), "a checkbox is added, unchecked");
const tf = fl.find((x) => x.type === "text"), cb = fl.find((x) => x.type === "checkbox");
ok(Math.abs(tf.bbox[0] - 300) < 1 && Math.abs(tf.bbox[1] - 600) < 1 && Math.abs(tf.bbox[3] - 622) < 1, "the field is where it was drawn: " + tf.bbox);
await f.setField(0, tf.id, "Jane Doe");
await f.setField(0, cb.id, true);
ok(f.formFields(0).find((x) => x.type === "text").value === "Jane Doe" && f.formFields(0).find((x) => x.type === "checkbox").checked, "filled in");
f.undo();
ok(!f.formFields(0).find((x) => x.type === "checkbox").checked, "undo unchecks the box (one step)");
f.redo();
const saved = f.export();
const g = mk(); g.open(saved, "g.pdf");
const gl = g.formFields(0);
ok(gl.length === 2 && gl.find((x) => x.type === "text").value === "Jane Doe" && gl.find((x) => x.type === "checkbox").checked, "the saved PDF reopens with its fields and values");
{ // the value is drawn in the field (its appearance), so other PDF readers show it
  const pg = mupdf.Document.openDocument(saved, "application/pdf").loadPage(0), pix = pg.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  const W = pix.getWidth(), px = pix.getPixels(); let dark = 0;
  for (let y = 1204; y < 1240; y++) for (let x = 604; x < 1036; x++) if (px[(y * W + x) * 3] < 100) dark++;
  ok(dark > 150, `the value is drawn in the field (${dark} dark pixels): other PDF readers show it`);
}
let err = ""; try { await f.addField(0, [10, 10, 12, 12], "text"); } catch (x) { err = x.message; }
ok(/larger box/.test(err), "a too small box is refused");

// ---------------------------------------------------------------- compare
const c = mk(); c.open(invoice, "c.pdf");
const line = c.pageText(0).find((x) => x.text.trim() === "Blue Harbor Consulting");
await c.editSpan(0, line.id, line.text, "Blue Lake Consulting");
await c.addText(0, 60, 700, "New line added here", { size: 10 });
const res = c.compareWith(invoice);
const p0 = res.pages[0];
const ch = p0.changed.find((x) => x.new === "Blue Lake Consulting");
ok(ch && ch.old === "Blue Harbor Consulting", "compare: the edited line is reported as changed, paired with its old version");
ok(ch && ch.ops.map((o) => o.op + ":" + o.t).join(" ") === "same:Blue del:Harbor ins:Lake same:Consulting", "compare: word by word: " + (ch && ch.ops.map((o) => o.op + ":" + o.t).join(" ")));
ok(ch && ch.ins.length === 1 && ch.ins[0][2] - ch.ins[0][0] < (ch.bbox[2] - ch.bbox[0]) * 0.6, "compare: only the changed word is highlighted, not the whole line");
ok(p0.added.length === 1 && p0.added[0].text === "New line added here" && p0.removed.length === 0, "compare: the new line is reported as new, nothing as removed");
// the case of one word deleted from a line
const w = mk(); w.open(invoice, "w.pdf");
const ln = w.pageText(0).find((x) => /Website design/.test(x.text)) || w.pageText(0).find((x) => x.editable && x.text.trim().split(/\s+/).length >= 2);
const words = ln.text.trim().split(/\s+/), gone = words[1];
await w.editSpan(0, ln.id, ln.text, words.filter((_, k) => k !== 1).join(" "));
const r1 = w.compareWith(invoice).pages[0];
const c1 = r1.changed[0];
ok(r1.changed.length === 1 && !r1.added.length && !r1.removed.length, "one word deleted: one changed line, nothing else (" + JSON.stringify(ln.text.trim()) + ")");
ok(c1 && c1.ops.filter((o) => o.op === "del").map((o) => o.t).join(" ") === gone && !c1.ops.some((o) => o.op === "ins"), "…the deleted word is named: " + gone);
ok(c1 && c1.del.length === 1 && c1.del[0].x > c1.bbox[0] && c1.del[0].x < c1.bbox[2], "…and its place on the line is marked");
// a slanted watermark across the text, then the watermark removed and one word deleted: the comparison
// shows that word and the watermark, nothing else (the watermark cut the lines, its removal redrew letters)
{
  const a = mk(); a.open(invoice, "a.pdf");
  const L = ["The purpose of this document is to provide customers with full transparency on the",
    "artificial intelligence systems used within the forecasting service. It sets out to explain",
    "how decisions are made, why specific results are produced and what data they are using.",
    "Any changes after the revision date will not be reflected in this documentation and may vary",
    "from these descriptions. More information about the forecasting services is available here.",
    "The forecasting service uses AI to plan the number of interactions to expect in future weeks.",
    "Each of these AI systems is explained further in the chapters below."];
  for (const [i, t] of L.entries()) await a.addText(0, 50, 470 + i * 16, t, { size: 10 });
  await a.watermark("NDA PROTECTED jane.doe@example.com", { opacity: 0.3 });
  const original = a.export();
  const b = mk(); b.open(original, "b.pdf");
  const wm = b.pageText(0).filter((x) => !x.editable);
  await b.removeText([{ page: 0, ids: b.similarText(0, wm[0].id).group }]);
  const ln = b.pageText(0).find((x) => x.editable && /artificial intelligence systems/.test(x.text));
  await b.editSpan(0, ln.id, ln.text, ln.text.replace("systems ", ""));
  const r = b.compareWith(original).pages[0];
  const diffs = r.changed.map((x) => x.ops.filter((o) => o.op !== "same").map((o) => o.op + ":" + o.t).join(" "));
  ok(diffs.length === 1 && diffs[0] === "del:systems", "watermark removed + one word deleted: only that word is reported as changed: " + JSON.stringify(diffs));
  ok(!r.added.length, "…no line wrongly reported as new: " + JSON.stringify(r.added.map((x) => x.text)));
  ok(r.removed.length === 1 && /NDA PROTECTED/.test(r.removed[0]), "…and the watermark is reported once as removed: " + JSON.stringify(r.removed));
  const back = a.compareWith(original).pages[0];
  ok(!back.changed.length && !back.added.length && !back.removed.length, "a PDF with a watermark compared with itself: no difference");
}
ok(c.compareWith(c.export()).pages.every((p) => !p.added.length && !p.removed.length), "compare with itself: no difference");
const two = mk(); two.open(invoice, "t.pdf"); await two.pageOp("duplicate", 0);
const r2 = c.compareWith(two.export());
ok(r2.otherPages === 2 && r2.extra.length === 1 && r2.extra[0].removed.length > 5, "compare with a longer PDF: its extra page is reported");
let err2 = ""; try { c.compareWith(new Uint8Array([1, 2, 3])); } catch (x) { err2 = x.message; }
ok(/could not be read/.test(err2), "compare with a file that is not a PDF: clear message");
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
