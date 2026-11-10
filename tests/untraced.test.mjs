// An edited PDF must not tell that it was edited: its properties stay those of the original.
// Compares, before and after an edit + save: the document information (title, author, subject,
// keywords, creator, producer, creation and modification dates), the XMP metadata, the file ID,
// the PDF version, and looks for any mention of the editor or its engine in the saved bytes.
// Run: node tests/untraced.test.mjs
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

const props = (bytes) => {
  const doc = new mupdf.PDFDocument(bytes);
  const tr = doc.getTrailer();
  const info = {};
  const I = tr.get("Info");
  if (I && I.isDictionary()) I.forEach((v, k) => { info[k] = v.isString() ? v.asString() : String(v); });
  const id = tr.get("ID");
  const ids = id && id.isArray() ? [0, 1].map((i) => [...id.get(i).asByteString()].map((b) => b.toString(16).padStart(2, "0")).join("")) : null;
  const meta = doc.getTrailer().get("Root").get("Metadata");
  const xmp = meta && meta.isStream() ? meta.readStream().asString() : null;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 12)).match(/^%PDF-(\d\.\d)/);
  return { info, ids, xmp, version: head && head[1] };
};

const files = [path.join(here, "fixtures", "demo-invoice.pdf"), path.join(here, "fixtures", "photo.pdf"),
  ...fs.readdirSync(path.join(process.env.HOME, "Desktop")).filter((f) => f.endsWith(".pdf")).map((f) => path.join(process.env.HOME, "Desktop", f))];
for (const f of files) {
  const orig = new Uint8Array(fs.readFileSync(f));
  let a;
  try { a = props(orig); } catch (e) { continue; }                       // not readable at all: skipped
  const e = mk();
  try { e.open(orig.slice(), path.basename(f)); } catch (er) { continue; }
  const sp = e.pageText(0).find((s) => s.editable && s.text.trim().length > 3);
  if (!sp) { console.log("  (no editable text: " + path.basename(f).slice(0, 40) + ")"); continue; }
  await e.editSpan(0, sp.id, sp.text, "Changed");
  const out = e.export();
  const b = props(out);
  const name = path.basename(f).slice(0, 34).padEnd(34);
  const infoSame = JSON.stringify(a.info) === JSON.stringify(b.info);
  const idSame = JSON.stringify(a.ids) === JSON.stringify(b.ids);
  const xmpSame = a.xmp === b.xmp;
  const verSame = a.version === b.version || (b.version < a.version);
  const text = new TextDecoder("latin1").decode(out);
  const count = (x) => (x.match(/MuPDF|mupdf|PDF Editor|pdf-editor|workers\.dev/g) || []).length;
  const mention = count(text) > count(new TextDecoder("latin1").decode(orig));     // more mentions than the original had
  ok(infoSame && idSame && xmpSame && verSame && !mention, `${name} properties unchanged` +
     (infoSame ? "" : ` | info ${JSON.stringify(a.info)} -> ${JSON.stringify(b.info)}`) + (idSame ? "" : ` | ID ${a.ids} -> ${b.ids}`) +
     (xmpSame ? "" : " | XMP changed") + (verSame ? "" : ` | version ${a.version} -> ${b.version}`) + (mention ? " | mentions the editor" : ""));
  const re = mk(); re.open(out, "x.pdf");
  if (!re.find("Changed").length) ok(false, `${name} the edit is in the saved file`);
}
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
