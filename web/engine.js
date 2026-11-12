/* PDF Editor - browser engine (MuPDF.js).
 *
 * Runs in a Web Worker in the browser, and in Node.js for tests.
 * Coordinates: everything the UI sees is in the *display* frame of a page
 * (rotation applied, y down, origin at the top-left corner), which is MuPDF's
 * own page space. Content is written to the PDF in its user space through the
 * inverse of the page transform, so rotated pages need no special case.
 *
 * Text replacement = real removal of the glyphs (redaction of text only; images
 * and vector graphics are left untouched) + new text drawn at the same baseline,
 * size, colour and alignment, with the best font available:
 *   1. the same font installed on the computer (Chrome/Edge, when allowed),
 *   2. the font embedded in the PDF, when it has every character needed,
 *   3. a bundled metric-compatible font (same widths: Liberation, Carlito, Caladea),
 *   4. a generic bundled font.
 */
import * as mupdf from "./vendor/mupdf/mupdf.js";
import { readFontFile } from "./fontfile.js";
export { readFontFile };

export class EditError extends Error {}

// MuPDF reports problems it repairs by itself ("bogus font ...") as warnings: keep them out of the error log.
try { mupdf.setLog({ warning: () => {}, error: (m) => console.warn("mupdf:", m) }); } catch (e) { /* older library */ }

const NORM_MAP = { "\u00ad": "-", "\u00a0": " ", "\u2007": " ", "\u202f": " " };
const norm = (s) => s.replace(/[\u00ad\u00a0\u2007\u202f]/g, (c) => NORM_MAP[c]);
const isSpace = (c) => /\s/.test(c);
const DIR_TO_ROT = { "1,0": 0, "0,-1": 90, "-1,0": 180, "0,1": 270 };
const MAX_UNDO = 40;
const MAX_UNDO_BYTES = 250 * 1024 * 1024;

/* ------------------------------------------------------------------ fonts */

const BOLD = new Set(["bold", "heavy", "extrabold", "ultrabold", "black"]);
const ITALIC = new Set(["italic", "oblique", "it", "inclined"]);
const REGULAR = new Set(["regular", "normal", "plain", "roman", "book"]);
const EXTRA = new Set(["light", "medium", "semibold", "demibold", "demi", "narrow", "condensed", "thin",
  "extralight", "ultralight", "semilight", "compressed", "extended"]);
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* PDF family names -> bundled metric-compatible family */
const COMPATIBLE = {
  arial: "liberationsans", helvetica: "liberationsans", helveticaneue: "liberationsans", arimo: "liberationsans",
  liberationsans: "liberationsans", nimbussans: "liberationsans", nimbussansl: "liberationsans",
  timesnewroman: "liberationserif", times: "liberationserif", timesroman: "liberationserif", tinos: "liberationserif",
  liberationserif: "liberationserif", nimbusroman: "liberationserif", nimbusromanno9l: "liberationserif",
  couriernew: "liberationmono", courier: "liberationmono", cousine: "liberationmono", liberationmono: "liberationmono",
  nimbusmono: "liberationmono", nimbusmonol: "liberationmono",
  calibri: "carlito", carlito: "carlito",
  cambria: "caladea", caladea: "caladea",
  dejavusans: "dejavusans", verdana: "dejavusans",
};

function splitWords(s) {
  return s.match(/[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|\d+/g) || [];
}

/** "ABCDEF+Arial-BoldItalicMT" -> {key:"arial", bold:true, italic:true, display:"Arial"} */
export function parsePdfFont(name) {
  let n = String(name || "").replace(/^[A-Z]{6}\+/, "").replace(/^\*/, "").replace(/-\d+$/, "").trim();
  let fam = n, style = "";
  const m = n.match(/^([^,\-]+)[,\-](.*)$/);
  if (m) { fam = m[1]; style = m[2]; }
  fam = fam.replace(/(PSMT|PS|MT)$/, "");
  style = style.replace(/(PSMT|PS|MT)$/, "");
  let words = [];
  for (const w of fam.split(/\s+/).filter(Boolean)) words.push(...(splitWords(w).length ? splitWords(w) : [w]));
  let stoks = splitWords(style).map((w) => w.toLowerCase());
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase();
    if (BOLD.has(last) || ITALIC.has(last) || EXTRA.has(last) || REGULAR.has(last) || ["semi", "extra", "ultra"].includes(last)) stoks.unshift(words.pop().toLowerCase());
    else break;
  }
  // "semi bold" -> "semibold"
  const joined = [];
  for (const t of stoks) {
    const prev = joined[joined.length - 1];
    if (prev && ["semi", "demi", "extra", "ultra"].includes(prev) && (t === "bold" || t === "light")) joined[joined.length - 1] = prev + t;
    else joined.push(t);
  }
  const bold = joined.some((t) => BOLD.has(t) || t === "semibold" || t === "demibold");
  const italic = joined.some((t) => ITALIC.has(t));
  const extras = joined.filter((t) => EXTRA.has(t) && t !== "semibold" && t !== "demibold");
  const base = normKey(words.join(""));
  return { key: base + extras.sort().join(""), base, bold, italic, display: words.join(" ") || n };
}

/** CSS weight from a font name ("Roboto-SemiBoldItalic" -> 600). */
export function weightOf(name, bold) {
  const t = String(name || "").replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[^a-z]/g, "");
  const W = { hairline: 100, thin: 100, extralight: 200, ultralight: 200, light: 300, medium: 500, semibold: 600, demibold: 600,
              demi: 600, extrabold: 800, ultrabold: 800, heavy: 800, black: 900, bold: 700 };
  // the last weight word wins ("Montserrat Thin SemiBold" is the SemiBold instance)
  const m = t.match(/(hairline|extralight|ultralight|semibold|demibold|extrabold|ultrabold|thin|light|medium|demi|heavy|black|bold)/g);
  return m ? W[m[m.length - 1]] : bold ? 700 : 400;
}
const FREE_CDN = "https://cdn.jsdelivr.net/fontsource/fonts/";

/** character -> byte, for the PDF's standard encodings of simple fonts */
function byteTable(enc) {
  try {
    const d = new TextDecoder(enc), m = new Map();
    for (let b = 32; b < 256; b++) { const ch = d.decode(new Uint8Array([b])); if (ch && ch !== "\ufffd" && !m.has(ch)) m.set(ch, b); }
    return m;
  } catch (e) { return null; }
}
const ENC = { winansi: byteTable("windows-1252"), macroman: byteTable("macintosh") };
const hexN = (n, w) => n.toString(16).padStart(w, "0");

function styleOf(styleStr) {
  const t = String(styleStr || "").toLowerCase();
  return { bold: /bold|black|heavy|semibold|demibold/.test(t), italic: /italic|oblique/.test(t) };
}

/** Bundled fonts (fonts/fonts.json) and, optionally, the computer's installed fonts. */
class FontLibrary {
  constructor(manifest, fetchBytes) {
    this.fetchBytes = fetchBytes;   // async (source) -> Uint8Array
    this.entries = [];              // {id, family, key, bold, italic, ps, source, kind}
    this.cache = new Map();         // id -> mupdf.Font
    this.bytes = new Map();         // id -> Uint8Array
    for (const f of manifest.fonts) {
      this.entries.push({ id: "b:" + f.file, family: f.family, key: f.key, bold: !!f.bold, italic: !!f.italic,
        ps: normKey(f.ps || ""), source: { type: "bundled", file: f.file }, kind: "bundled", label: f.label || f.family });
    }
    this.compatibleOf = manifest.compatible || {};
    this.free = null;               // catalogue of free fonts (fonts/free-fonts.json), set by the worker
  }
  /** Free font entries (one per character subset, best weight/style) for a PDF font, or []. */
  freeEntries(info, psname, bold, italic) {
    if (!this.free) return [];
    let c = this.free[info.base] || this.free[info.key];
    let fam = info.base;
    if (!c) {                        // "OpenSansCondensed" etc.: try the longest known prefix
      for (let n = info.key.length; n >= 4 && !c; n--) if (this.free[info.key.slice(0, n)]) { c = this.free[info.key.slice(0, n)]; fam = info.key.slice(0, n); }
      if (!c || fam.length < info.base.length) return [];
    }
    const [id, family, weights, styles, subsets, ver] = c;
    if (!ver || !/^\d+\.\d+\.\d+$/.test(ver) || !/^[a-z0-9-]+$/.test(id)) return [];   // only pinned, well-formed fonts
    const want = weightOf(psname, bold);
    const w = weights.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a), weights[0]);
    const st = italic && styles & 2 ? "italic" : styles & 1 ? "normal" : "italic";
    return subsets.map((sub) => {
      const eid = `f:${id}:${sub}:${w}:${st}`;
      let e = this.entries.find((x) => x.id === eid);
      if (!e) {
        e = { id: eid, family, key: normKey(family), bold: w >= 600, italic: st === "italic", ps: "", kind: "free",
              source: { type: "free", url: `${FREE_CDN}${id}@${ver}/${sub}-${w}-${st}.ttf` }, label: family, subset: sub };
        this.entries.push(e);
      }
      return e;
    });
  }
  addLocal(list) {
    this.entries = this.entries.filter((e) => e.kind !== "local" || e.source.type === "user");
    for (const f of list) {
      const st = styleOf(f.style);
      this.entries.push({ id: "l:" + f.postscriptName, family: f.family, key: normKey(f.family), bold: st.bold, italic: st.italic,
        ps: normKey(f.postscriptName), source: { type: "local", postscriptName: f.postscriptName }, kind: "local", label: f.family });
    }
  }
  /** Fonts the person added from files. They count as "this computer's fonts" and win over
   *  the browser's list (same font, but already in memory). */
  addUser(list) {
    const ids = new Set(list.map((f) => "u:" + f.id));
    this.entries = this.entries.filter((e) => !ids.has(e.id));
    const user = list.map((f) => ({ id: "u:" + f.id, family: f.family, key: normKey(f.family), bold: !!f.bold, italic: !!f.italic,
      ps: normKey(f.ps), psName: f.ps, size: f.size || 0, source: { type: "user", id: f.id, file: f.file, index: f.index || 0 }, kind: "local", label: f.family }));
    this.entries = [...user, ...this.entries];
  }
  removeUser(ids) {
    const drop = new Set(ids.map((i) => "u:" + i));
    this.entries = this.entries.filter((e) => !drop.has(e.id));
    for (const id of drop) { this.cache.delete(id); this.bytes.delete(id); }
  }
  userFonts() {
    return this.entries.filter((e) => e.source.type === "user").map((e) => ({ id: e.source.id, family: e.family, bold: e.bold, italic: e.italic, file: e.source.file }));
  }
  hasLocal() { return this.entries.some((e) => e.kind === "local"); }
  static pick(cands, bold, italic) {
    let best = null, bs = -1;
    for (const e of cands) {
      const s = (e.bold === bold ? 2 : 0) + (e.italic === italic ? 1 : 0);
      if (s > bs) { best = e; bs = s; }
    }
    return best;
  }
  /** kind: "local" | "bundled" | undefined (any) */
  lookup(key, bold, italic, kind, psname) {
    const pool = this.entries.filter((e) => !kind || e.kind === kind);
    if (psname) {
      const ps = normKey(String(psname).replace(/^[A-Z]{6}\+/, ""));
      const e = pool.find((x) => x.ps && x.ps === ps && x.bold === bold && x.italic === italic);
      if (e) return e;
    }
    const cands = pool.filter((e) => e.key === key);
    if (!cands.length) return null;
    const e = FontLibrary.pick(cands, bold, italic);
    return e;
  }
  async font(entry) {
    if (!this.cache.has(entry.id)) {
      const data = await this.load(entry);
      this.cache.set(entry.id, new mupdf.Font(entry.family, data, entry.source.index || 0));
    }
    return this.cache.get(entry.id);
  }
  async load(entry) {
    if (!this.bytes.has(entry.id)) this.bytes.set(entry.id, await this.fetchBytes(entry.source));
    return this.bytes.get(entry.id);
  }
  families() {
    const seen = new Map();
    for (const e of this.entries) {
      if (e.kind === "free") continue;
      const k = (e.kind === "local" ? "l:" : "b:") + e.key;
      if (!seen.has(k)) seen.set(k, { key: k, label: e.kind === "bundled" ? e.label : e.family, kind: e.kind });
    }
    const all = [...seen.values()];
    return {
      bundled: all.filter((f) => f.kind === "bundled"),
      local: all.filter((f) => f.kind === "local").sort((a, b) => a.label.localeCompare(b.label)),
    };
  }
}

/* ------------------------------------------------------------------ font files */

/* ------------------------------------------------------------------ the PDF's own fonts */

/** Does this glyph draw anything? (subset fonts keep empty slots for the glyphs they dropped,
 *  with a bounding box, so the only sure test is to draw it) */
let INK_PIX = null;
function hasInk(font, gid) {
  try {
    INK_PIX = INK_PIX || new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 24, 24], false);
    INK_PIX.clear(255);
    const t = new mupdf.Text();
    t.showGlyph(font, [20, 0, 0, -20, 2, 18], gid, 0, 0);
    const dev = new mupdf.DrawDevice(M.identity, INK_PIX);
    dev.fillText(t, M.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
    dev.close(); dev.destroy(); t.destroy();
    const px = INK_PIX.getPixels();
    for (let i = 0; i < px.length; i++) if (px[i] < 200) return true;
    return false;
  } catch (e) { return false; }
}

/** Vertical extent of a glyph's ink, in em above the baseline: [bottom, top], or null if empty. */
/** Centre of a glyph's outline on the page (where a removal looks for it). */
let SS_C = null;
function glyphCentre(g) {
  try {
    SS_C = SS_C || new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 1, miterLimit: 10 });
    const t = new mupdf.Text();
    t.showGlyph(g.fontObj, g.m, g.gid, g.unicode || 0, 0);
    const b = t.getBounds(SS_C, M.identity);
    t.destroy();
    if (b[2] > b[0] && b[3] > b[1]) return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  } catch (e) {}
  return [g.x, g.y];
}
let INK_PIX2 = null;
function inkSpan(font, gid) {
  try {
    const S = 60;
    INK_PIX2 = INK_PIX2 || new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 100, 200], false);
    INK_PIX2.clear(255);
    const t = new mupdf.Text();
    t.showGlyph(font, [S, 0, 0, -S, 20, 140], gid, 0, 0);
    const dev = new mupdf.DrawDevice(M.identity, INK_PIX2);
    dev.fillText(t, M.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
    dev.close(); dev.destroy(); t.destroy();
    const px = INK_PIX2.getPixels();
    let top = -1, bot = -1;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 100; x++) if (px[y * 100 + x] < 128) { if (top < 0) top = y; bot = y; }
    return top < 0 ? null : [(140 - bot) / S, (140 - top) / S];
  } catch (e) { return null; }
}
/* Characters whose ink normally starts on the baseline (no descender): used to spot glyphs that
 * a PDF stores shifted up or down (it then moves them back when it draws them). */
const ON_BASELINE = /^[0-9A-IK-PR-Zabcdefhiklmnorstuvwxz]$/;

function parseToUnicode(src) {
  // char -> code, from a ToUnicode CMap (bfchar + bfrange); single characters only
  const map = new Map(), byCode = new Map();
  map.byCode = byCode;
  const u16 = (h) => { let s = ""; for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
  const put = (code, str) => {
    if ([...str].length !== 1 || str === "\ufffd") return;
    if (!byCode.has(code)) byCode.set(code, str);
    if (!map.has(str)) map.set(str, code);
  };
  for (const blk of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) put(parseInt(m[1], 16), u16(m[2]));
  }
  for (const blk of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[4] !== undefined) {
        const base = u16(m[4]);
        if (!base) continue;
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) put(c, base.slice(0, -1) + String.fromCharCode(last + c - lo));
      } else {
        const list = [...m[5].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => u16(x[1]));
        list.forEach((str, i) => put(lo + i, str));
      }
    }
  }
  return map;
}

/** Can new text be written with this font dictionary? -> {names, kind, map, width, hasToUnicode} */
function readPdfFont(f, nm) {
  const sub = nm(f.get("Subtype"));
  const tu = f.get("ToUnicode");
  let tmap = null;
  if (tu && tu.isStream()) { try { tmap = parseToUnicode(tu.readStream().asString()); } catch (e) { tmap = null; } }
  if (sub === "Type0") {
    if (nm(f.get("Encoding")) !== "Identity-H" || !tmap || !tmap.size) return null;
    const d = f.get("DescendantFonts").get(0);
    const dw = d.get("DW").isNumber() ? d.get("DW").asNumber() : 1000;
    const W = new Map(), w = d.get("W");
    if (w && w.isArray()) {
      for (let i = 0; i < w.length; ) {
        const a = w.get(i).asNumber(), b = w.get(i + 1);
        if (b.isArray()) { for (let k = 0; k < b.length; k++) W.set(a + k, b.get(k).asNumber()); i += 2; }
        else { const hi = b.asNumber(), v = w.get(i + 2).asNumber(); for (let c = a; c <= hi && c - a < 65536; c++) W.set(c, v); i += 3; }
      }
    }
    const c2g = d.get("CIDToGIDMap");
    const gidIsCid = nm(d.get("Subtype")) === "CIDFontType2" && (!c2g || c2g.isNull() || nm(c2g) === "Identity");
    return { names: [nm(f.get("BaseFont")), nm(d.get("BaseFont"))], kind: "cid", map: tmap, byCode: tmap.byCode, hasToUnicode: true, gidIsCid,
             width: (code) => (W.has(code) ? W.get(code) : dw) / 1000 };
  }
  if (sub === "TrueType" || sub === "Type1") {
    const e = nm(f.get("Encoding"));
    const kind = e === "WinAnsiEncoding" ? "winansi" : e === "MacRomanEncoding" ? "macroman" : null;
    if (!kind || !ENC[kind]) return null;
    const first = f.get("FirstChar").isNumber() ? f.get("FirstChar").asNumber() : 0;
    const ws = f.get("Widths");
    // no widths (one of the 14 standard fonts, only named): its letters can be put back where they
    // were, but it is not used to write new text (no letter is offered: empty map)
    if (!ws || !ws.isArray()) return { names: [nm(f.get("BaseFont"))], kind, map: new Map(), width: () => 0, hasToUnicode: !!(tmap && tmap.size), putBackOnly: true };
    const width = (code) => { const i = code - first; return i >= 0 && i < ws.length ? ws.get(i).asNumber() / 1000 : 0; };
    const map = new Map();
    for (const [ch, code] of ENC[kind]) {
      if (width(code) <= 0) continue;                       // not in the font
      if (tmap && tmap.size && !tmap.has(ch)) continue;     // the table says what the subset holds
      map.set(ch, code);
    }
    return { names: [nm(f.get("BaseFont"))], kind, map, width, hasToUnicode: !!(tmap && tmap.size) };
  }
  return null;
}




/* ------------------------------------------------------------------ ZIP (stored, no compression) */
let crcTable = null;
/** files: [{name, bytes: Uint8Array | string}] -> the bytes of a .zip (used for .docx and bundles). */
export function makeZip(files) {
  const enc = new TextEncoder();
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const d = new Date();
  const stamp = (((d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate()) << 16 | (d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1)) >>> 0;
  const local = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.bytes instanceof Uint8Array ? f.bytes : enc.encode(String(f.bytes)), c = crc(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(10, stamp, true); h.setUint32(14, c, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    local.push(new Uint8Array(h.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint32(12, stamp, true); ch.setUint32(16, c, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const parts = [...local, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

/* ------------------------------------------------------------------ no trace of the editor in saved files */
/** The file the engine wrote, without what would tell that it was rewritten: the engine's
 *  "% Written by MuPDF" comment (blanked, same length, so every offset stays valid) and a newer
 *  PDF version number than the original's. The title, author, dates and producer are never
 *  changed, and the file ID is kept (regenerate-id=no). */
function untraced(bytes, version) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 96));
  const m = head.match(/% Written by MuPDF[^\r\n]*/);
  if (m) for (let i = m.index + 1; i < m.index + m[0].length; i++) bytes[i] = 0x20;       // keep "%": a blank comment
  const v = head.match(/^%PDF-(\d)\.(\d)/);
  if (v && version && /^\d\.\d$/.test(version) && version < `${v[1]}.${v[2]}`) {
    bytes[5] = version.charCodeAt(0); bytes[7] = version.charCodeAt(2);
  }
  return bytes;
}

/* ------------------------------------------------------------------ active content */
const DANGEROUS_ACTIONS = new Set(["JavaScript", "Launch", "SubmitForm", "ImportData", "Rendition", "Sound", "Movie", "RichMediaExecute", "GoToE"]);
// links are fine (web, mail, phone, or written without a scheme like "www.example.com");
// a link that runs code or opens local files is not
const BAD_URI = /^\s*(javascript|vbscript|data|file|blob|about|chrome|ms-[a-z-]+|jar|smb|\\\\)/i;
/** Find (and with fix, remove) active content. Walks every object once. */
function scanActive(doc, fix) {
  const kinds = {};
  const hit = (k) => (kinds[k] = (kinds[k] || 0) + 1);
  const nm = (o) => { try { return o && o.isName() ? o.asName() : null; } catch (e) { return null; } };
  const str = (o) => { try { return o && o.isString() ? o.asString() : ""; } catch (e) { return ""; } };
  // an action dictionary: dangerous types, and URI actions that are not plain web or mail links
  const badAction = (a) => {
    if (!a || !a.isDictionary || !a.isDictionary()) return null;
    const t = nm(a.get("S"));
    if (DANGEROUS_ACTIONS.has(t)) return t;
    if (t === "URI" && BAD_URI.test(str(a.get("URI")).replace(/[\u0000-\u0020]+/g, ""))) return "URI";
    return null;
  };
  const n = doc.countObjects();
  for (let i = 1; i < n; i++) {
    let o;
    try { o = doc.newIndirect(i); if (!o.isDictionary()) continue; } catch (e) { continue; }
    try {
      // the object is itself a dangerous action (referenced from somewhere)
      const self = badAction(o);       // (the action objects themselves; their uses are counted once)
      if (self) { hit(self); if (fix) { o.put("S", doc.newName("GoTo")); o.put("D", doc.newArray()); for (const k of ["JS", "F", "Win", "Mac", "Unix", "URI", "Fields", "R", "Sound", "Movie", "Next"]) o.delete(k); } }
      // actions attached to it: /A, /OpenAction, additional actions /AA, chained /Next
      for (const key of ["A", "OpenAction"]) {
        const a = o.get(key);
        if (a && a.isDictionary && a.isDictionary() && !a.isIndirect()) { const b = badAction(a); if (b) { hit(b); if (fix) o.delete(key); } }
        else if (a && a.isIndirect && a.isIndirect()) { const b = badAction(a.resolve ? a.resolve() : a); if (b && fix && key === "OpenAction") o.delete(key); }
      }
      const aa = o.get("AA");
      if (aa && aa.isDictionary && aa.isDictionary()) { hit("automatic"); if (fix) o.delete("AA"); }
      // document-level scripts and attached files (Names tree), XFA forms, attachments on pages
      const names = o.get("Names");
      if (names && names.isDictionary && names.isDictionary()) {
        for (const k of ["JavaScript", "EmbeddedFiles"]) if (names.get(k) && !names.get(k).isNull()) { hit(k === "JavaScript" ? "JavaScript" : "attachment"); if (fix) names.delete(k); }
      }
      if (nm(o.get("Type")) === "Catalog" || o.get("AcroForm")) {
        const af = o.get("AcroForm");
        if (af && af.isDictionary && af.isDictionary() && af.get("XFA") && !af.get("XFA").isNull()) { hit("XFA"); if (fix) af.delete("XFA"); }
      }
      if (nm(o.get("Subtype")) === "FileAttachment") { hit("attachment"); if (fix) { o.delete("FS"); o.put("Subtype", doc.newName("Text")); } }
    } catch (e) { /* unusual object: skipped */ }
  }
  const total = Object.values(kinds).reduce((a, v) => a + v, 0);
  return { total, kinds };
}

/* ------------------------------------------------------------------ geometry helpers */

const M = mupdf.Matrix;
const xform = (p, m) => [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
const rd = (v) => Math.round(v * 100) / 100;
const fmt = (v) => {
  const s = (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4);
  return s.replace(/\.?0+$/, "") || "0";
};
function quadRect(q) {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** Character box; fonts that declare absurd ascent/descent get a sane height instead. */
function tightBox(q, o, size, dir) {
  const hx = q[0] - q[4], hy = q[1] - q[5];             // lower-left -> upper-left
  if (Math.hypot(hx, hy) <= 1.35 * size || !size) return quadRect(q);
  const len = Math.hypot(dir[0], dir[1]) || 1, dx = dir[0] / len, dy = dir[1] / len, ux = dy, uy = -dx;
  const adv = Math.hypot(q[2] - q[0], q[3] - q[1]);
  const pts = [];
  for (const t of [0, adv]) for (const u of [-0.22 * size, 0.92 * size]) pts.push([o[0] + t * dx + u * ux, o[1] + t * dy + u * uy]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
/** Writing direction of a line as a unit vector, or null when it is really tilted.
 *  Lines within 6° of an axis (a slightly skewed scan or table) keep their own exact angle. */
const MAX_TILT = Math.cos(6 * Math.PI / 180);
function rdir(d) {
  const x = Math.round(d[0]), y = Math.round(d[1]);
  if (Math.abs(d[0] - x) < 0.02 && Math.abs(d[1] - y) < 0.02 && Math.abs(x) + Math.abs(y) === 1) return [x, y];
  const n = Math.hypot(d[0], d[1]);
  if (!n) return null;
  const ux = d[0] / n, uy = d[1] / n;
  return Math.max(Math.abs(ux), Math.abs(uy)) >= MAX_TILT ? [ux, uy] : null;
}
const axisKey = (d) => `${Math.round(d[0])},${Math.round(d[1])}`;
function hex(color) {
  const c = (color || [0, 0, 0]).map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function rgb(c) {
  if (Array.isArray(c)) return c;
  const s = String(c || "#000000").replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((x) => x + x).join("") : s, 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ------------------------------------------------------------------ writing into a page */

/** True when appended content would inherit a transformed state from the page
 *  (top-level "cm" outside q/Q, or unbalanced q/Q) - then the old content is wrapped. */
function needsWrap(src) {
  let depth = 0, i = 0;
  const n = src.length;
  const ws = (c) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
  const delim = (c) => "()<>[]{}/%".includes(c);
  while (i < n) {
    const c = src[i];
    if (ws(c)) { i++; continue; }
    if (c === "%") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "(") {                       // literal string with nesting and escapes
      let d = 1; i++;
      while (i < n && d > 0) { const ch = src[i]; if (ch === "\\") i += 2; else { if (ch === "(") d++; else if (ch === ")") d--; i++; } }
      continue;
    }
    if (c === "<") { if (src[i + 1] === "<") { i += 2; continue; } while (i < n && src[i] !== ">") i++; i++; continue; }
    if (c === ">" || c === "[" || c === "]" || c === "{" || c === "}") { i++; continue; }
    if (c === "/") { i++; while (i < n && !ws(src[i]) && !delim(src[i])) i++; continue; }
    let j = i;
    while (j < n && !ws(src[j]) && !delim(src[j])) j++;
    const tok = src.slice(i, j) || src[i];
    i = Math.max(j, i + 1);
    if (tok === "q") depth++;
    else if (tok === "Q") { depth--; if (depth < 0) return true; }
    else if (tok === "cm" && depth === 0) return true;
    else if (tok === "ID") {               // inline image data: skip to EI
      const k = src.indexOf("EI", i);
      i = k < 0 ? n : k + 2;
    }
  }
  return depth !== 0;
}

function readContents(pobj) {
  const c = pobj.get("Contents");
  if (!c || c.isNull()) return "";
  if (c.isArray()) {
    let s = "";
    for (let i = 0; i < c.length; i++) { const it = c.get(i); if (it.isStream()) s += it.readStream().asString() + "\n"; }
    return s;
  }
  return c.isStream() ? c.readStream().asString() : "";
}

function subDict(doc, dict, name) {
  let d = dict.get(name);
  if (!d || d.isNull()) { dict.put(name, doc.newDictionary()); d = dict.get(name); }
  return d;
}

function pageResources(doc, pobj) {
  let res = pobj.get("Resources");
  if (!res || res.isNull()) {
    const inh = pobj.getInheritable("Resources");
    const fresh = doc.newDictionary();
    if (inh && !inh.isNull()) inh.forEach((v, k) => fresh.put(k, v));
    pobj.put("Resources", fresh);
    res = pobj.get("Resources");
  }
  return res;
}

/** Append a content stream to a page, wrapping the existing content in q/Q if needed. */
function appendContent(doc, page, ops) {
  const pobj = page.getObject();
  const old = pobj.get("Contents");
  const arr = doc.newArray();
  const items = [];
  if (old && !old.isNull()) {
    if (old.isArray()) for (let i = 0; i < old.length; i++) items.push(old.get(i));
    else items.push(old);
  }
  if (items.length && needsWrap(readContents(pobj))) {
    arr.push(doc.addStream("q\n", {}));
    for (const it of items) arr.push(it);
    arr.push(doc.addStream("\nQ\n", {}));
  } else {
    for (const it of items) arr.push(it);
  }
  arr.push(doc.addStream("\n" + ops + "\n", {}));
  pobj.put("Contents", arr);
}

/* ------------------------------------------------------------------ the engine */

export class Engine {
  /**
   * @param {object} opts
   *   manifest: fonts/fonts.json contents
   *   fetchBytes: async (source) -> Uint8Array   (bundled file or local font)
   *   persist: optional async (name, bytes) -> void, called after each change
   */
  constructor(opts) {
    this.fonts = new FontLibrary(opts.manifest, opts.fetchBytes);
    this.persist = opts.persist || null;
    this.allowFree = opts.allowFree !== false;   // download free fonts (Google Fonts...) when a PDF uses them
    this.s = null;   // current session
  }

  /* -------------------------------------------------- session & history */
  open(bytes, name, password) {
    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let doc;
    try { doc = mupdf.Document.openDocument(data, "application/pdf"); }
    catch (e) { throw new EditError("This file could not be read as a PDF"); }
    if (doc.needsPassword()) {
      if (!password) throw new EditError("PASSWORD_REQUIRED");
      if (!doc.authenticatePassword(password)) throw new EditError("WRONG_PASSWORD");
      data = doc.asPDF().saveToBuffer("decrypt,regenerate-id=no").asUint8Array().slice();
      doc = mupdf.Document.openDocument(data, "application/pdf");
    }
    const pdf = doc.asPDF();
    if (!pdf) throw new EditError("Not a PDF file");
    // check the new document fully before it replaces the open one (a broken PDF must not
    // leave the editor half-switched: OWASP A10)
    const head = new TextDecoder("latin1").decode(data.subarray(0, 16)).match(/^%PDF-(\d\.\d)/);
    let fileId = null;                       // the original file ID, put back on every save
    try {
      const id = pdf.getTrailer().get("ID");
      if (id && id.isArray() && id.length === 2) fileId = [id.get(0).asByteString().slice(), id.get(1).asByteString().slice()];
    } catch (e) {}
    const next = { name: name || "document.pdf", doc: pdf, version: head ? head[1] : null, fileId, tokens: [], undo: [], redo: [], fontRefs: new Map(),
                   embCache: new Map(), textCache: new Map() };
    let n;
    try {
      n = pdf.countPages();
      if (!n) throw new Error("no page");
      for (let i = 0; i < n; i++) next.tokens.push(this._tok());
      const prev = this.s;
      this.s = next;
      try { return this.info(); }
      catch (e) { this.s = prev; throw e; }
    } catch (e) {
      if (e instanceof EditError) throw e;
      throw new EditError(/cycle|page tree/i.test(e.message) ? "This PDF is damaged (its page list is broken) and cannot be opened" : "This file could not be read as a PDF");
    }
  }

  _tok() { return Math.random().toString(36).slice(2, 10); }
  _need() { if (!this.s) throw new EditError("No document is open"); return this.s; }

  info() {
    const s = this._need();
    const pages = [];
    for (let i = 0; i < s.doc.countPages(); i++) {
      const p = s.doc.loadPage(i);
      const b = p.getBounds();
      const rot = p.getObject().getInheritable("Rotate");
      pages.push({ w: b[2] - b[0], h: b[3] - b[1], rotation: rot && !rot.isNull() ? ((rot.asNumber() % 360) + 360) % 360 : 0, v: s.tokens[i] });
    }
    return { name: s.name, pages, canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 };
  }

  _snapshot() {
    const s = this.s;
    return { data: s.doc.saveToBuffer("regenerate-id=no").asUint8Array().slice(), tokens: [...s.tokens] };
  }

  _checkpoint() {
    const s = this.s;
    s.undo.push(this._snapshot());
    s.lastRedo = s.redo.slice();             // kept in case the change turns out to be empty
    s.redo.length = 0;
    let total = s.undo.reduce((a, x) => a + x.data.length, 0);
    while (s.undo.length > MAX_UNDO || (s.undo.length > 1 && total > MAX_UNDO_BYTES)) {
      total -= s.undo.shift().data.length;
    }
  }

  /** The change just started did nothing: forget its undo step, give the redo history back. */
  _dropCheckpoint() {
    const s = this.s;
    if (!s.undo.length) return;
    s.undo.pop();
    s.redo = s.lastRedo || [];
    s.lastRedo = null;
  }

  _reload(data) {
    const s = this.s;
    s.doc = mupdf.Document.openDocument(data, "application/pdf").asPDF();
    s.fontRefs = new Map();
    s.embCache = new Map();
    s.textCache = new Map();
    s.origCache = null;
  }

  async _changed(pages) {
    const s = this.s;
    for (const p of pages) { s.tokens[p] = this._tok(); s.textCache.delete(p); }
    s.embCache = new Map();
    if (this.persist) this._schedulePersist();
  }

  _schedulePersist() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => this.flushPersist(), 800);
  }
  /** Write the recovery copy now (before the PDF is marked as saved, so a late copy cannot undo that). */
  flushPersist() {
    if (!this._pt || !this.persist || !this.s) return;
    clearTimeout(this._pt); this._pt = null;
    try { return this.persist(this.s.name, this.s.doc.saveToBuffer("regenerate-id=no").asUint8Array().slice()); } catch (e) { /* best effort */ }
  }

  undo() {
    const s = this._need();
    if (!s.undo.length) return this.info();
    s.redo.push(this._snapshot());
    const snap = s.undo.pop();
    this._reload(snap.data);
    s.tokens = snap.tokens;
    if (this.persist) this._schedulePersist();
    return this.info();
  }

  redo() {
    const s = this._need();
    if (!s.redo.length) return this.info();
    s.undo.push(this._snapshot());
    const snap = s.redo.pop();
    this._reload(snap.data);
    s.tokens = snap.tokens;
    if (this.persist) this._schedulePersist();
    return this.info();
  }

  /* -------------------------------------------------- rendering */
  render(pno, scale) {
    const s = this._need();
    scale = Math.max(0.1, Math.min(Number(scale) || 1, 5));
    const page = s.doc.loadPage(pno);
    const pix = page.toPixmap(M.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents(), stride = pix.getStride();
    const src = pix.getPixels();
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      let si = y * stride, di = y * w * 4;
      for (let x = 0; x < w; x++, si += n, di += 4) {
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
      }
    }
    pix.destroy();
    return { w, h, pixels: out, v: s.tokens[pno] };
  }

  /* -------------------------------------------------- fonts used for new text */
  _embedded(page, fontObj) {
    // The PDF's own font (a Font from the text extraction), usable when it can encode the text.
    if (!fontObj) return null;
    const key = fontObj.getName();
    const s = this.s;
    if (!s.embCache.has(key)) s.embCache.set(key, fontObj);
    return s.embCache.get(key);
  }

  static covers(font, text) {
    for (const ch of text) {
      if (isSpace(ch)) continue;
      if (!font.encodeCharacter(ch.codePointAt(0))) return false;
    }
    return true;
  }

  /** The page's fonts that new text can be written with directly, by font name:
   *  name -> {num, kind, map: char -> code, width: code -> advance (1/1000 em)}.
   *  Type0 Identity-H fonts (the most common) use the PDF's own ToUnicode table, so every letter
   *  the document can show is available; simple fonts with a standard encoding use that encoding. */
  _origFonts(pno) {
    const s = this.s, key = pno + ":" + s.tokens[pno];
    s.origCache = s.origCache || new Map();
    if (s.origCache.has(key)) return s.origCache.get(key);
    const out = new Map();
    const nm = (o) => (o && o.isName() ? o.asName() : "");
    const strip = (n) => n.replace(/^[A-Z]{6}\+/, "").replace(/-Identity-[HV]$/, "");
    const done = new Set();
    const scan = (res, depth) => {
      if (!res || res.isNull() || depth > 2) return;
      const fonts = res.get("Font");
      if (fonts && !fonts.isNull()) fonts.forEach((f) => {
        try {
          if (!f.isIndirect() || done.has(f.asIndirect())) return;
          done.add(f.asIndirect());
          const info = readPdfFont(f, nm);
          if (!info) return;
          for (const n of info.names) if (n && !out.has(strip(n))) out.set(strip(n), { num: f.asIndirect(), ...info });
        } catch (e) { /* unusual font dictionary: skip */ }
      });
      const xo = res.get("XObject");
      if (xo && !xo.isNull()) xo.forEach((x) => { try { if (nm(x.get("Subtype")) === "Form") scan(x.get("Resources"), depth + 1); } catch (e) {} });
    };
    try { scan(s.doc.loadPage(pno).getObject().getInheritable("Resources"), 0); } catch (e) {}
    s.origCache.set(key, out);
    return out;
  }

  /** Chain entries for the PDF's own fonts of the same family and style as `sp`, on its page.
   *  A letter is reused only when its glyph is surely in the embedded font: the document already
   *  shows it in that font, or (TrueType, where the glyph can be checked) it has visible ink. */
  _origEntries(pno, sp, text) {
    const strip = (n) => n.replace(/^[A-Z]{6}\+/, "").replace(/-Identity-[HV]$/, "");
    const dicts = this._origFonts(pno);
    const need = new Set([...(text || "")].filter((ch) => !isSpace(ch)));
    const seen = new Map();                     // font name -> {sp, chars it shows, glyphs used per char}
    const collect = (q) => {
      for (const l of this._lines(q)) for (const x of l.spans) {
        const v = seen.get(x.fontName) || { sp: x, chars: new Set(), gids: new Map(), checked: 0, agree: 0 };
        for (const c of x.chars) {
          if (c.font.getName() !== x.fontName) continue;      // a look-alike letter merged into the text
          v.chars.add(c.c);
          if (c.gid == null || isSpace(c.c)) continue;
          const g = v.gids.get(c.c) || new Map();
          g.set(c.gid, (g.get(c.gid) || 0) + 1);
          v.gids.set(c.c, g);
        }
        seen.set(x.fontName, v);
      }
    };
    collect(pno);
    const sameFont = (x) => x.fontName === sp.fontName || (x.info.key === sp.info.key && x.bold === sp.bold && x.italic === sp.italic);
    const has = (ch) => [...seen.values()].some((v) => sameFont(v.sp) && v.chars.has(ch));
    const n = this.s.doc.countPages();
    for (let d = 1; d < n && d <= 10 && [...need].some((ch) => !has(ch)); d++) for (const q of [pno - d, pno + d]) if (q >= 0 && q < n) collect(q);
    const same = [...seen.values()].filter((v) => sameFont(v.sp));
    same.sort((a, b) => (b.sp.fontName === sp.fontName) - (a.sp.fontName === sp.fontName));
    const out = [], done = new Set();
    for (const { sp: x, chars, gids } of same) {
      const d = dicts.get(strip(x.fontName));
      if (!d || done.has(d.num)) continue;
      done.add(d.num);
      // Are the glyph numbers the codes of this font? (true for most embedded CID fonts) Then each
      // letter is written with the very glyph the document uses for it, not just any glyph that
      // the font labels with that letter (a PDF may label border pieces "1" or "-").
      let agree = 0, total = 0;
      if (d.kind === "cid" && d.byCode) for (const [ch, g] of gids) for (const [gid, n] of g) { total += n; if (d.byCode.get(gid) === ch) agree += n; }
      const known = total >= 3 && agree >= 0.95 * total;
      const map = new Map(), rise = new Map();
      if (known) {
        for (const [ch, g] of gids) {
          // the glyph used most often for this letter
          const gid = [...g].sort((a, b) => b[1] - a[1])[0][0];
          map.set(ch, gid);
        }
      }
      for (const [ch, code] of d.map) {
        if (map.has(ch)) continue;
        if (chars.has(ch) || ((d.gidIsCid || known) && hasInk(x.fontObj, code))) map.set(ch, code);
      }
      // glyphs this page uses as drawings (borders, rules) are never used to write letters
      for (const l of this._lines(pno)) for (const c of l.deco || []) if (c.gid != null && map.get(c.c) === c.gid) map.delete(c.c);
      if (!map.size) continue;
      // glyphs whose outline is stored shifted (the PDF moves them back where it draws them)
      if (known || d.gidIsCid) for (const [ch, code] of map) {
        if (!ON_BASELINE.test(ch)) continue;
        const ink = inkSpan(x.fontObj, code);
        if (ink && Math.abs(ink[0]) > 0.12) rise.set(code, ink[0]);
      }
      out.push({ id: "o:" + d.num, font: x.fontObj, label: sp.info.display, kind: "exact",
                 orig: { num: d.num, kind: d.kind, map, width: d.width, rise, known, fontName: x.fontName } });
    }
    return out;
  }

  /** Glyph id (or code, for the PDF's own fonts) of a character in a chain entry; 0 = not available. */
  _gid(fr, ch) {
    if (fr.orig) { const c = fr.orig.map.get(ch); return c === undefined ? 0 : c + 1; }   // +1: code 0 is valid
    try { return fr.font.encodeCharacter(ch.codePointAt(0)); } catch (e) { return 0; }
  }
  /** What to write in the content stream for this glyph. */
  _code(fr, ch, gid) {
    if (fr.orig) return hexN(gid - 1, fr.orig.kind === "cid" ? 4 : 2);
    return hexN(gid, 4);
  }
  /** Advance of a glyph, in text space units (size 1). */
  _adv(fr, gid) {
    if (fr.orig) return fr.orig.width(gid - 1);
    return fr.font.advanceGlyph(gid);
  }

  /** Fonts to draw `text` replacing span `sp` (or new text when sp is null), best first.
   *  Each character is drawn with the first font of the chain that has it, so a letter missing
   *  from the PDF's embedded subset does not switch the whole text to a look-alike font.
   *  Returns {fonts, font, id, label, kind, mixed}: font/id/label/kind describe the main font. */
  async resolveFont(sp, text, fontKey, bold, italic) {
    const info = sp ? sp.info : parsePdfFont("Arial");
    const b0 = sp ? sp.bold : false, i0 = sp ? sp.italic : false;
    bold = bold == null ? b0 : bold;
    italic = italic == null ? i0 : italic;
    const styled = bold !== b0 || italic !== i0;
    const lib = this.fonts, chain = [], seen = new Set();
    const push = (fr) => { if (fr && !seen.has(fr.id)) { seen.add(fr.id); chain.push(fr); } };
    const add = async (e, kind) => {
      if (!e || seen.has(e.id)) return;
      try { push({ id: e.id, font: await lib.font(e), label: e.label, kind, entry: e }); } catch (err) { /* unavailable (offline...) */ }
    };
    const missing = () => [...new Set([...text].filter((ch) => !isSpace(ch)))].filter((ch) => !chain.some((fr) => this._gid(fr, ch)));
    if (fontKey) {                                  // explicit user choice "b:key" / "l:key"
      const [k, key] = [fontKey.slice(0, 1), fontKey.slice(2)];
      await add(lib.lookup(key, bold, italic, k === "l" ? "local" : "bundled"), "chosen");
    } else if (sp) {
      // 0. the PDF's own font: every letter the document already shows in it is reused as is
      if (!styled && sp.pno != null) { try { for (const fr of this._origEntries(sp.pno, sp, text)) if (missing().length) push(fr); } catch (e) {} }
      // 1. same font installed on this computer (or added from a file)
      if (missing().length) await add(lib.lookup(info.key, bold, italic, "local", styled ? null : sp.font) || lib.lookup(info.base, bold, italic, "local"), styled ? "chosen" : "exact");
      // 2. the font embedded in the PDF, re-embedded (when its letters can be looked up)
      if (!styled && sp.fontObj && missing().length) {
        try { if (this._canEmbed(sp.fontObj) && missing().some((ch) => sp.fontObj.encodeCharacter(ch.codePointAt(0)))) push({ id: "e:" + sp.fontObj.getName(), font: sp.fontObj, label: info.display, kind: "exact" }); } catch (e) {}
      }
      // 3. the same font from the free font library, when it is a free font (downloaded on demand)
      if (this.allowFree && missing().length) {
        for (const e of lib.freeEntries(info, sp.font, bold, italic)) {
          if (!missing().length) break;
          if (e.subset !== "latin" && !missing().some((ch) => ch.codePointAt(0) > 0x7f)) continue;
          await add(e, styled ? "chosen" : "free");
        }
      }
      // 4. bundled font with the same character widths
      const ck = COMPATIBLE[info.key] || COMPATIBLE[info.base];
      if (ck && missing().length) await add(lib.lookup(ck, bold, italic, "bundled"), "compatible");
    }
    // 5. generic bundled fonts, for whatever is still missing
    const generic = sp && sp.serif ? "liberationserif" : sp && sp.mono ? "liberationmono" : "liberationsans";
    for (const k of [generic, "liberationsans", "dejavusans"]) if (!chain.length || missing().length) await add(lib.lookup(k, bold, italic, "bundled"), "fallback");
    if (!chain.length) push({ id: "base:Helvetica", font: new mupdf.Font("Helvetica"), label: "Helvetica", kind: "fallback" });
    // which font draws how many characters
    const counts = new Map();
    for (const ch of text) if (!isSpace(ch)) { const fr = this._pick(chain, ch); counts.set(fr, (counts.get(fr) || 0) + 1); }
    // entries of the same font (the PDF's own subsets, a downloaded copy...) count as one
    const byLabel = new Map();
    for (const [fr, n] of counts) { const k = fr.label + "|" + (fr.kind === "fallback" || fr.kind === "compatible" ? fr.kind : "same"); const v = byLabel.get(k) || [fr, 0]; v[1] += n; byLabel.set(k, v); }
    const used = [...byLabel.values()].sort((a, b) => b[1] - a[1]);
    const main = used.length ? used[0][0] : chain[0];
    const others = used.slice(1).filter((x) => x[0].label !== main.label);
    const n = others.reduce((a, x) => a + x[1], 0);
    let label = main.label;
    if (others.length) label += ` + ${others.map((x) => x[0].label).join(", ")} for ${n} character${n > 1 ? "s" : ""} it lacks`;
    const installed = [...counts.keys()].filter((fr) => fr.entry && fr.entry.source && fr.entry.source.type === "local").map((fr) => fr.entry.source.postscriptName);
    return { fonts: chain, font: main.font, id: main.id, label, kind: main.kind, mixed: n, mainLabel: main.label, installed };
  }

  /** First font of the chain that has this character (spaces: preferably the previous one). */
  _pick(chain, ch, prev) {
    if (isSpace(ch)) {
      if (prev && this._gid(prev, " ")) return prev;
      return chain.find((fr) => this._gid(fr, " ")) || chain[chain.length - 1];
    }
    return chain.find((fr) => this._gid(fr, ch)) || chain[chain.length - 1];
  }

  /** Split a line into runs of one font: [{fr, codes, adv}] (adv in text space units, size 1). */
  _runs(chain, line) {
    const runs = [];
    let prev = null;
    for (let ch of line) {
      if (isSpace(ch)) ch = " ";
      const fr = this._pick(chain, ch, prev);
      const gid = this._gid(fr, ch);
      if (!gid && !isSpace(ch)) continue;            // no font at all has it
      if (!gid) {                                    // a space no font has: leave a gap instead
        const w = 0.278, last = runs[runs.length - 1];
        if (last) { last.codes += `> -${w * 1000} <`; last.adv += w; }
        else runs.push({ fr, codes: `> -${w * 1000} <`, adv: w, rise: 0 });
        continue;
      }
      const adv = this._adv(fr, gid);
      const code = this._code(fr, ch, gid);
      const rise = (fr.orig && fr.orig.rise && fr.orig.rise.get(gid - 1)) || 0;
      const last = runs[runs.length - 1];
      if (last && last.fr === fr && last.rise === rise) { last.codes += code; last.adv += adv; }
      else runs.push({ fr, codes: code, adv, rise });
      prev = fr;
    }
    return runs;
  }

  /** Can this font of the PDF be embedded again? Not when it has no font file (Type3 fonts, whose
   *  letters are drawings, or fonts the PDF only names). Checked once per font, in a scratch PDF. */
  _canEmbed(font) {
    if (!font) return false;
    const k = font.getName();
    this._embedOk = this._embedOk || new Map();
    if (!this._embedOk.has(k)) {
      let ok = false;
      try { (this._scratch = this._scratch || new mupdf.PDFDocument()).addFont(font); ok = true; } catch (e) {}
      this._embedOk.set(k, ok);
    }
    return this._embedOk.get(k);
  }

  _fontRef(fontRes) {
    const s = this.s;
    if (!s.fontRefs.has(fontRes.id)) s.fontRefs.set(fontRes.id, s.doc.addFont(fontRes.font).asIndirect());
    return s.doc.newIndirect(s.fontRefs.get(fontRes.id));
  }

  _aliasFor(dict, num) {
    let found = null;
    dict.forEach((v, k) => { if (!found && v.isIndirect() && v.asIndirect() === num) found = k; });
    if (found) return found;
    let name = "PDFO" + num, n = 0;
    while (!dict.get(name).isNull()) name = "PDFO" + num + "_" + (++n);
    return name;
  }

  _alias(dict, prefix, id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let name = prefix + h.toString(36);
    let n = 0;
    while (true) {
      const ex = dict.get(name);
      if (!ex || ex.isNull()) return name;
      if (ex.isIndirect() && ex.asIndirect() === this.s.fontRefs.get(id)) return name;
      name = prefix + h.toString(36) + "_" + (++n);
    }
  }

  /** Font resource names on a page for every font of a chain. */
  _aliases(page, chain) {
    const doc = this.s.doc;
    const fdict = subDict(doc, pageResources(doc, page.getObject()), "Font");
    const out = new Map();
    for (const fr of chain) {
      const ref = fr.orig ? doc.newIndirect(fr.orig.num) : this._fontRef(fr);
      const alias = fr.orig ? this._aliasFor(fdict, fr.orig.num) : this._alias(fdict, "PDFE", fr.id);
      fdict.put(alias, ref);
      out.set(fr, alias);
    }
    return out;
  }

  /** Draw text lines. origin/dir in display coords; align uses extent [t0,t1] along dir. */
  _drawText(page, origin, dir, text, fontRes, size, color, align = "left", extent = [0, 0], opacity = 1) {
    const chain = fontRes.fonts || [fontRes];
    const inv = M.invert(page.getTransform());
    const [dx, dy] = dir, down = [-dy, dx];
    const [r, g, b] = rgb(color);
    const lines = text.split("\n").map((line) => (line.trim() ? this._runs(chain, line) : null));
    const used = [...new Set(lines.flat().filter(Boolean).map((run) => run.fr))];
    const alias = this._aliases(page, used);
    const gs = opacity < 1 ? `/${this._alphaState(page, opacity)} gs\n` : "";
    let ops = `q\n${gs}${fmt(r)} ${fmt(g)} ${fmt(b)} rg\nBT\n`;
    lines.forEach((runs, n) => {
      if (!runs) return;
      const w = runs.reduce((a, run) => a + run.adv, 0) * size;
      const t = align === "right" ? extent[1] - w : align === "center" ? (extent[0] + extent[1] - w) / 2 : 0;
      const off = n * 1.2 * size;
      const ox = origin[0] + t * dx + off * down[0], oy = origin[1] + t * dy + off * down[1];
      const trm = M.concat([size * dx, size * dy, size * dy, -size * dx, ox, oy], inv);
      ops += `${trm.map(fmt).join(" ")} Tm\n`;
      for (const run of runs) {
        // a glyph stored shifted is put back on the baseline with the text rise
        ops += `/${alias.get(run.fr)} 1 Tf ${run.rise ? fmt(-run.rise) + " Ts " : ""}[<${run.codes}>] TJ${run.rise ? " 0 Ts" : ""}\n`;
      }
    });
    ops += "ET\nQ";
    appendContent(this.s.doc, page, ops);
  }

  /** Draw characters at their original positions shifted by delta (moving keeps the exact
   *  letter spacing, kerning and justification of the original). */
  _drawChars(page, chars, dir, delta, fontRes, color) {
    const chain = fontRes.fonts || [fontRes];
    const inv = M.invert(page.getTransform());
    const [dx, dy] = dir;
    const [r, g, b] = rgb(color);
    const picks = chars.map((c) => (isSpace(c.c) ? null : this._pick(chain, c.c)));
    const alias = this._aliases(page, [...new Set(picks.filter(Boolean))]);
    let ops = `q\n${fmt(r)} ${fmt(g)} ${fmt(b)} rg\nBT\n`;
    let prev = null, cur = null, prevOwn = false;   // prev: {origin, adv} of the last glyph drawn
    chars.forEach((c, i) => {
      const fr = picks[i];
      if (!fr) { prev = null; return; }
      // the character's own glyph when it comes from the same font (moving keeps it identical);
      // the following letters of a ligature (ff, fi…) come with the same glyph: it is drawn once
      const own = fr.orig && fr.orig.known && c.gid != null && fr.orig.fontName === c.font.getName();
      const wNow = Math.abs((c.bbox[2] - c.bbox[0]) * dx) + Math.abs((c.bbox[3] - c.bbox[1]) * dy);
      if (prevOwn && c.gid == null && wNow < 0.05 * c.size && !/\p{M}/u.test(c.c)) return;   // drawn by the ligature glyph
      prevOwn = own;
      const gid = own ? c.gid + 1 : this._gid(fr, c.c);
      if (!gid) return;
      const sz = c.size;
      const adv = this._adv(fr, gid) * sz;
      const rise = own ? 0 : (fr.orig && fr.orig.rise && fr.orig.rise.get(gid - 1)) || 0;
      // the 2nd+ letters of a ligature (ff, fi, ffl...) come with zero width at the end of the
      // ligature: draw them right after the previous letter instead, at its natural advance
      const w = Math.abs((c.bbox[2] - c.bbox[0]) * dx) + Math.abs((c.bbox[3] - c.bbox[1]) * dy);
      let o = c.origin;
      if (prev && w < 0.05 * sz && !/\p{M}/u.test(c.c)) o = [prev.origin[0] + prev.adv * dx, prev.origin[1] + prev.adv * dy];
      const up = [dy, -dx];
      const trm = M.concat([sz * dx, sz * dy, sz * dy, -sz * dx, o[0] + delta[0] - rise * sz * up[0], o[1] + delta[1] - rise * sz * up[1]], inv);
      if (fr !== cur) { ops += `/${alias.get(fr)} 1 Tf\n`; cur = fr; }
      ops += `${trm.map(fmt).join(" ")} Tm\n<${this._code(fr, c.c, gid)}> Tj\n`;
      prev = { origin: o, adv };
    });
    ops += "ET\nQ";
    appendContent(this.s.doc, page, ops);
  }

  _fillRect(page, rect, color) {
    const inv = M.invert(page.getTransform());
    const pts = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]].map((p) => xform(p, inv));
    const [r, g, b] = rgb(color);
    const path = pts.map((p, i) => `${fmt(p[0])} ${fmt(p[1])} ${i ? "l" : "m"}`).join("\n");
    appendContent(this.s.doc, page, `q\n${fmt(r)} ${fmt(g)} ${fmt(b)} rg\n${path}\nh f\nQ`);
  }

  _redact(page, rects, full = false) {
    for (const r of rects) {
      const a = page.createAnnotation("Redact");
      a.setRect(r);
    }
    if (full) page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    else page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
  }

  /** Font descriptors on a page whose Ascent/Descent are far too large. MuPDF decides
   *  which glyphs a removal touches from these values, so such fonts would make it
   *  take characters from the neighbouring lines too. */
  _badFontDescs(page) {
    const bad = new Map();
    const scan = (res, depth) => {
      if (!res || res.isNull() || depth > 2) return;
      const fonts = res.get("Font");
      if (fonts && !fonts.isNull()) fonts.forEach((f) => {
        let fd = f.get("FontDescriptor");
        if (!fd || fd.isNull()) { const ds = f.get("DescendantFonts"); if (ds && ds.isArray() && ds.length) fd = ds.get(0).get("FontDescriptor"); }
        if (!fd || fd.isNull() || !fd.isIndirect()) return;
        const a = fd.get("Ascent"), d = fd.get("Descent");
        const asc = a && a.isNumber() ? a.asNumber() : 0, desc = d && d.isNumber() ? d.asNumber() : 0;
        if (asc > 1100 || desc < -350) bad.set(fd.asIndirect(), { num: fd.asIndirect(), asc, desc });
      });
      const xo = res.get("XObject");
      if (xo && !xo.isNull()) xo.forEach((x) => {
        const sub = x.get("Subtype");
        if (sub && sub.isName() && sub.asName() === "Form") scan(x.get("Resources"), depth + 1);
      });
    };
    try { scan(page.getObject().getInheritable("Resources"), 0); } catch (e) { /* unusual structure: skip */ }
    return [...bad.values()];
  }

  /** Remove the text under `rects` on page pno - and only that text. */
  /** Remove the text under `rects` - and only that text. The PDF library sometimes takes more
   *  (glyphs whose box merely touches the area) or moves the glyphs that follow the removed ones
   *  on a slanted line; so the page's glyphs are compared before and after, and every glyph that
   *  was not meant to go is put back exactly where it was. */
  _redactPage(pno, rects, keepOthers = true, onlyKeys = null) {
    if (!keepOthers) { this._redactOnly(pno, rects); return; }
    const before = this._glyphSnapshot(pno);
    const inside = (g) => { const c = glyphCentre(g); return rects.some((r) => c[0] >= r[0] - 0.05 && c[0] <= r[2] + 0.05 && c[1] >= r[1] - 0.05 && c[1] <= r[3] + 0.05); };
    // the edited text is level (or vertical): letters drawn at a slant across it - a stamp, a
    // watermark - are not part of it and are always put back
    const level = (g) => { const a = Math.abs(Math.atan2(g.m[1], g.m[0])) % (Math.PI / 2); return Math.min(a, Math.PI / 2 - a) < 0.05; };
    const intended = onlyKeys || new Set(before.filter((g) => inside(g) && level(g)).map((g) => g.key));
    this._redactOnly(pno, rects);
    const was = new Set(before.map((g) => g.key));
    for (let round = 0; round < 4; round++) {
      // glyphs that moved by themselves: take them away (they are redrawn at their place below);
      // a removal matches a glyph by the centre of its outline, so aim there
      const moved = this._glyphSnapshot(pno).filter((g) => !was.has(g.key));
      if (!moved.length) break;
      this._redactOnly(pno, moved.map((g) => { const c = glyphCentre(g); return [c[0] - 0.05, c[1] - 0.05, c[0] + 0.05, c[1] + 0.05]; }));
    }
    const now = new Set(this._glyphSnapshot(pno).map((g) => g.key));
    const lost = before.filter((g) => !intended.has(g.key) && !now.has(g.key));
    // in reading order: line by line (direction, then distance across), then along the line
    const keyOf = (g) => { const l = Math.hypot(g.m[0], g.m[1]) || 1, d = [g.m[0] / l, g.m[1] / l];
      return [Math.round(Math.atan2(d[1], d[0]) * 50), Math.round((g.x * -d[1] + g.y * d[0]) * 2), g.x * d[0] + g.y * d[1]]; };
    lost.sort((a, b) => { const ka = keyOf(a), kb = keyOf(b); return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]; });
    if (lost.length) this._putGlyphs(pno, lost);
    this._lastLost = lost;
  }

  /** Every glyph drawn on a page: font, glyph id, character, exact matrix, colour. */
  _glyphSnapshot(pno) {
    const out = [];
    const toRgb = (cs, c) => {
      const n = cs ? cs.getNumberOfComponents() : c.length;
      if (n === 1) return [c[0], c[0], c[0]];
      if (n === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
      return [c[0] || 0, c[1] || 0, c[2] || 0];
    };
    try {
      const dev = new mupdf.Device({ fillText(text, ctm, cs, color, alpha) {
        const rgbc = toRgb(cs, color || [0]), a = alpha == null ? 1 : Math.round(alpha * 100) / 100;
        text.walk({ showGlyph(font, trm, gid, unicode) {
          if (gid < 0) return;
          const m = M.concat(trm, ctm), name = font.getName();
          out.push({ font: name, fontObj: font, gid, unicode, m, x: m[4], y: m[5], rgb: rgbc, alpha: a, key: `${name}|${gid}|${Math.round(m[4] * 8)}|${Math.round(m[5] * 8)}` });
        } });
      } });
      this.s.doc.loadPage(pno).run(dev, M.identity);
      dev.close();
    } catch (e) { /* page with unreadable content: compare nothing */ }
    return out;
  }

  /** Draw glyphs exactly as they were (same font object, glyph, matrix and colour). */
  _putGlyphs(pno, glyphs) {
    const s = this.s, page = s.doc.loadPage(pno);
    const strip = (n) => n.replace(/^[A-Z]{6}\+/, "").replace(/-Identity-[HV]$/, "");
    s.origCache = null;
    const dicts = this._origFonts(pno);
    const byFont = new Map();
    for (const g of glyphs) {
      const d = dicts.get(strip(g.font));
      if (!d) continue;
      let code = null;
      const ch = g.unicode > 0 ? String.fromCodePoint(g.unicode) : "";
      if (d.kind === "cid") { if (!d.byCode || d.byCode.get(g.gid) === ch || !d.byCode.has(g.gid) && !ch) code = hexN(g.gid, 4); }
      else if (ENC[d.kind] && ENC[d.kind].has(ch)) code = hexN(ENC[d.kind].get(ch), 2);
      if (code === null) continue;
      if (!byFont.has(d.num)) byFont.set(d.num, []);
      byFont.get(d.num).push({ ...g, code });
    }
    if (!byFont.size) return;
    const fdict = subDict(s.doc, pageResources(s.doc, page.getObject()), "Font");
    const inv = M.invert(page.getTransform());
    let ops = "q\nBT\n";
    for (const [num, list] of byFont) {
      const alias = this._aliasFor(fdict, num);
      fdict.put(alias, s.doc.newIndirect(num));
      ops += `/${alias} 1 Tf\n`;
      // each letter with its colour and its transparency (a stamp or a watermark is often see-through)
      let alpha = 1;
      for (const g of list) {
        if ((g.alpha ?? 1) !== alpha) { alpha = g.alpha ?? 1; ops += `/${this._alphaState(page, alpha)} gs\n`; }
        ops += `${g.rgb.map(fmt).join(" ")} rg ${M.concat(g.m, inv).map(fmt).join(" ")} Tm <${g.code}> Tj\n`;
      }
      if (alpha !== 1) ops += `/${this._alphaState(page, 1)} gs\n`;
    }
    ops += "ET\nQ";
    appendContent(s.doc, page, ops);
  }

  _redactOnly(pno, rects, full = false) {
    const s = this.s;
    const bad = this._badFontDescs(s.doc.loadPage(pno));
    if (!bad.length) { this._redact(s.doc.loadPage(pno), rects, full); return; }
    // Work on a fresh copy in which those fonts are loaded with sane metrics, then restore them.
    const tmp = mupdf.Document.openDocument(s.doc.saveToBuffer("regenerate-id=no").asUint8Array().slice(), "application/pdf").asPDF();
    for (const b of bad) { const fd = tmp.newIndirect(b.num); fd.put("Ascent", Math.min(b.asc, 950)); fd.put("Descent", Math.max(b.desc, -250)); }
    this._redact(tmp.loadPage(pno), rects, full);
    for (const b of bad) { const fd = tmp.newIndirect(b.num); fd.put("Ascent", b.asc); fd.put("Descent", b.desc); }
    s.doc = tmp;            // object numbers are unchanged, so fontRefs stay valid
    s.origCache = null;
    s.textCache = new Map();
  }

  /* -------------------------------------------------- text model */
  _offset(page) { const b = page.getBounds(); return [b[0], b[1]]; }

  /** Lines of a page: [{bi, li, dir, spans:[{id, chars, ...}]}], cached per page version. */
  _lines(pno) {
    const s = this.s;
    const cached = s.textCache.get(pno);
    if (cached && cached.v === s.tokens[pno]) return cached.lines;
    const page = s.doc.loadPage(pno);
    const st = page.toStructuredText("preserve-whitespace,preserve-ligatures");
    const lines = [];
    let bi = -1, li = 0, cur = null;
    st.walk({
      beginTextBlock() { bi++; li = 0; },
      beginLine(bbox, wmode, dir) { cur = { bi, li: li++, dir, chars: [] }; },
      onChar(c, origin, font, size, quad, color) {
        cur.chars.push({ c, origin, bbox: tightBox(quad, origin, size, cur.dir), size, font, color });
      },
      endLine() { if (cur && cur.chars.length) lines.push(cur); cur = null; },
    });
    st.destroy();
    // which glyph draws each character, and exactly where (to move text and restore drawings
    // with their own glyphs, never with another glyph that has the same letter)
    try {
      const drawn = new Map();
      const dev = new mupdf.Device({ fillText(text, ctm) {
        text.walk({ showGlyph(font, trm, glyph, unicode) {
          if (glyph < 0) return;                  // 2nd+ letters of a ligature: no glyph of their own
          const m = M.concat(trm, ctm), k = font.getName() + "|" + unicode;
          if (!drawn.has(k)) drawn.set(k, []);
          drawn.get(k).push({ gid: glyph, m });
        } });
      } });
      page.run(dev, M.identity);
      dev.close();
      for (const l of lines) for (const c of l.chars) {
        const list = drawn.get(c.font.getName() + "|" + c.c.codePointAt(0));
        if (!list) continue;
        const i = list.findIndex((g) => Math.abs(g.m[4] - c.origin[0]) < 0.3 && Math.abs(g.m[5] - c.origin[1]) < 0.3);
        if (i >= 0) { c.gid = list[i].gid; c.dtrm = list[i].m; list.splice(i, 1); }
      }
    } catch (e) { /* glyphs unknown: the text model still works */ }
    // Some generators draw table borders and dotted rules with glyphs and label them as text
    // ("1" for a vertical border, "-" for rule pieces). They are part of the drawing, not of the
    // words: keep them on the page untouched, but out of the text that is searched and edited.
    //  - zero-width characters that are not letters (rule pieces between digits)
    //  - "digits" much narrower than the font's real digits (digits are all the same width)
    const width = (c, d) => Math.abs((c.bbox[2] - c.bbox[0]) * d[0]) + Math.abs((c.bbox[3] - c.bbox[1]) * d[1]);
    const digitW = new Map();
    for (const l of lines) {
      const d = rdir(l.dir) || [1, 0];
      for (const c of l.chars) {
        if (!/\p{Nd}/u.test(c.c)) continue;
        const k = c.font.getName() + "|" + rd(c.size);
        if (!digitW.has(k)) digitW.set(k, []);
        digitW.get(k).push(width(c, d));
      }
    }
    for (const [k, ws] of digitW) { ws.sort((a, b) => a - b); digitW.set(k, ws[Math.floor(ws.length / 2)]); }
    for (const l of lines) {
      const d = rdir(l.dir) || [1, 0];
      l.deco = [];
      l.chars = l.chars.filter((c) => {
        if (isSpace(c.c)) return true;
        const w = width(c, d);
        let deco = (w < 0.08 * c.size && !/[\p{L}\p{M}]/u.test(c.c)) ||
                   (/[-_=~\ufffd]/.test(c.c) && w > 0.9 * c.size);       // a "-" wider than a letter is a rule
        if (!deco && /\p{Nd}/u.test(c.c)) {
          const ref = digitW.get(c.font.getName() + "|" + rd(c.size));
          deco = ref >= 0.4 * c.size && w < 0.6 * ref;
        }
        if (deco) l.deco.push(c);
        return !deco;
      });
    }
    for (let i = lines.length - 1; i >= 0; i--) if (!lines[i].chars.some((c) => !isSpace(c.c))) lines.splice(i, 1);
    for (const l of lines) {
      l.spans = [];
      let sp = null, lastInk = null;
      const d = rdir(l.dir) || [1, 0];
      const along = (p) => p[0] * d[0] + p[1] * d[1];
      for (const ch of l.chars) {
        const fname = ch.font.getName();
        const key = fname + "|" + rd(ch.size) + "|" + hex(ch.color);
        // a wide gap (another column of a table) starts a new piece of text
        const start = Math.min(along([ch.bbox[0], ch.bbox[1]]), along([ch.bbox[2], ch.bbox[3]]));
        const far = lastInk !== null && !isSpace(ch.c) && start - lastInk > 2 * ch.size;
        if (!isSpace(ch.c)) lastInk = Math.max(along([ch.bbox[0], ch.bbox[1]]), along([ch.bbox[2], ch.bbox[3]]));
        if (far) {
          while (sp && sp.chars.length && isSpace(sp.chars[sp.chars.length - 1].c)) sp.chars.pop();
          sp = null;
        }
        if (!sp || sp.key !== key) {
          sp = { key, chars: [], fontName: fname, fontObj: ch.font, size: ch.size, color: ch.color, gap: far };
          l.spans.push(sp);
        }
        sp.chars.push(ch);
      }
      // A few letters an edit drew with a look-alike font (the PDF's font lacked them) stay part
      // of the surrounding text, so clicking it edits the whole piece again.
      const lookalike = (x) => /^(liberation(sans|serif|mono)|carlito|caladea|dejavusans)/.test(parsePdfFont(x.fontName).key);
      const style = (x) => { const i = parsePdfFont(x.fontName); let b = i.bold, it = i.italic; try { b = b || x.fontObj.isBold(); it = it || x.fontObj.isItalic(); } catch (e) {} return (b ? "B" : "") + (it ? "I" : ""); };
      const near = (a, b) => a && b && Math.abs(a.size - b.size) < 0.05 && hex(a.color) === hex(b.color) && style(a) === style(b);
      for (let i = 0; i < l.spans.length; i++) {
        const x = l.spans[i];
        if (!lookalike(x) || x.chars.filter((c) => !isSpace(c.c)).length > 3) continue;
        const prev = l.spans[i - 1], next = l.spans[i + 1];
        // the host is the PDF's own text: another font, or the same family (when the PDF's font is
        // itself one of the look-alikes, e.g. a PDF made with Liberation Sans)
        const fam = (a) => parsePdfFont(a.fontName).key;
        const ok = (h) => near(h, x) && (!lookalike(h) || fam(h) === fam(x)) && !(h === next && next.gap);
        const host = ok(prev) && !x.gap ? prev : next && ok(next) ? next : null;
        if (!host) continue;
        if (host === prev) { prev.chars.push(...x.chars); l.spans.splice(i, 1); i--; }
        else { next.chars.unshift(...x.chars); l.spans.splice(i, 1); i--; }
      }
      // pieces of one text: the same font, or the same family drawn from two copies of it (the PDF's
      // subset and the full font an edit added for the letters the subset lacks)
      for (let i = 1; i < l.spans.length; i++) {
        const a = l.spans[i - 1], b = l.spans[i];
        const sameFam = parsePdfFont(a.fontName).key === parsePdfFont(b.fontName).key && near(a, b);
        if ((b.key === a.key || sameFam) && !b.gap) { a.chars.push(...b.chars); l.spans.splice(i, 1); i--; }
      }
      l.spans.forEach((sp, si) => {
        sp.id = `${l.bi}.${l.li}.${si}`;
        sp.text = norm(sp.chars.map((c) => c.c).join(""));
        sp.info = parsePdfFont(sp.fontName);
        let fb = false, fi = false, fs = false, fm = false;
        try { fb = sp.fontObj.isBold(); fi = sp.fontObj.isItalic(); fs = sp.fontObj.isSerif(); fm = sp.fontObj.isMono(); } catch (e) {}
        // the family name says more than the PDF's flags ("Microsoft Sans Serif" is flagged serif)
        const nm = sp.info.base;
        if (/mono|courier|consol|menlo|typewriter/.test(nm)) { fm = true; fs = false; }
        else if (/sans|arial|helvet|calibri|verdana|tahoma|segoe|aptos|roboto|gothic|grotesk/.test(nm)) { fs = false; fm = false; }
        else if (/serif|times|roman|minion|garamond|georgia|cambria|book|palat|caslon|baskerv/.test(nm)) { fs = true; fm = false; }
        sp.bold = sp.info.bold || fb;
        sp.italic = sp.info.italic || fi;
        sp.serif = fs; sp.mono = fm;
        sp.font = sp.fontName;
        sp.pno = pno;
      });
      delete l.chars;
    }
    s.textCache.set(pno, { v: s.tokens[pno], lines });
    return lines;
  }

  /** Guess each span's alignment from nearby lines sharing its left/right edge or centre. */
  _alignMap(lines) {
    const groups = new Map();
    for (const l of lines) {
      const dr = rdir(l.dir);
      if (!dr) continue;
      for (const sp of l.spans) {
        const cs = sp.chars.filter((c) => !isSpace(c.c));
        if (!cs.length) continue;
        let a = Infinity, z = -Infinity;
        for (const c of cs) {
          const p1 = c.bbox[0] * dr[0] + c.bbox[1] * dr[1], p2 = c.bbox[2] * dr[0] + c.bbox[3] * dr[1];
          a = Math.min(a, p1, p2); z = Math.max(z, p1, p2);
        }
        const o = cs[0].origin;
        const perp = o[0] * -dr[1] + o[1] * dr[0];
        const k = axisKey(dr);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ perp, id: sp.id, a, z, size: sp.size });
      }
    }
    const out = new Map(), tol = 0.8;
    for (const items of groups.values()) {
      items.sort((x, y) => x.perp - y.perp);
      for (const it of items) {
        const reach = 4 * Math.max(it.size, 4);
        let nl = 0, nr = 0, nc = 0;
        for (const o of items) {
          if (o.id === it.id || Math.abs(o.perp - it.perp) < 0.5 || Math.abs(o.perp - it.perp) > reach) continue;
          const L = Math.abs(it.a - o.a) <= tol, R = Math.abs(it.z - o.z) <= tol;
          if (L && R) continue;
          if (L) nl++;
          else if (R) nr++;
          else if (Math.abs((it.a + it.z) - (o.a + o.z)) / 2 <= tol && Math.abs((it.z - it.a) - (o.z - o.a)) > 3) nc++;
        }
        out.set(it.id, nr > nl && nr >= nc ? "right" : nc > nl && nc > nr ? "center" : "left");
      }
    }
    return out;
  }

  /** What resolveFont will most likely pick, without loading any font file. */
  _predictFont(sp, origOk) {
    const lib = this.fonts, info = sp.info;
    const local = lib.lookup(info.key, sp.bold, sp.italic, "local", sp.font) || lib.lookup(info.base, sp.bold, sp.italic, "local");
    const ck = COMPATIBLE[info.key] || COMPATIBLE[info.base];
    const compat = ck ? lib.lookup(ck, sp.bold, sp.italic, "bundled") : null;
    const generic = lib.lookup(sp.serif ? "liberationserif" : sp.mono ? "liberationmono" : "liberationsans", sp.bold, sp.italic, "bundled");
    const free = this.allowFree ? lib.freeEntries(info, sp.font, sp.bold, sp.italic) : [];
    const backup = free.length ? free[0].label + " (free font)" : compat ? compat.label : null;
    if (local) return { label: local.family, kind: "exact", previewId: local.id };
    if (origOk) return { label: info.display, kind: "embedded", previewId: (free[0] || compat || generic || {}).id || null, compatLabel: backup };
    let emb = false;
    try { emb = this._canEmbed(sp.fontObj) && (sp.fontObj.encodeCharacter(65) > 0 || [...sp.text].some((ch) => !isSpace(ch) && sp.fontObj.encodeCharacter(ch.codePointAt(0)) > 0)); } catch (e) {}
    if (emb) return { label: info.display, kind: "embedded", previewId: (free[0] || compat || generic || {}).id || null, compatLabel: backup };
    if (free.length) return { label: free[0].label, kind: "free", previewId: free[0].id };
    if (compat) return { label: compat.label, kind: "compatible", previewId: compat.id };
    return { label: generic ? generic.label : "Helvetica", kind: "fallback", previewId: generic ? generic.id : null };
  }

  /** Names of the fonts that draw characters on a page, letter by letter (for checks and tests). */
  fontsUsed(pno, contains) {
    const out = new Set();
    for (const l of this._lines(pno)) {
      const line = l.spans.map((sp) => sp.text).join("");
      if (contains && !line.includes(contains)) continue;
      for (const sp of l.spans) for (const c of sp.chars) if (!isSpace(c.c)) out.add(c.font.getName().replace(/^[A-Z]{6}\+/, ""));
    }
    return [...out];
  }

  setFreeCatalog(cat) { this.fonts.free = cat; if (this.s) this.s.textCache = new Map(); }
  setFreeFonts(on) { this.allowFree = !!on; if (this.s) this.s.textCache = new Map(); return this.allowFree; }

  pageText(pno) {
    const s = this._need();
    const page = s.doc.loadPage(pno);
    const [ox, oy] = this._offset(page);
    const lines = this._lines(pno);
    const amap = this._alignMap(lines);
    const out = [], origOk = new Map();
    for (const l of lines) {
      for (const sp of l.spans) {
        if (!sp.text.trim()) continue;
        const ink = sp.chars.filter((c) => !isSpace(c.c));
        let bbox = sp.chars[0].bbox, tbox = ink[0].bbox;
        for (const c of sp.chars) bbox = union(bbox, c.bbox);
        for (const c of ink) tbox = union(tbox, c.bbox);
        if (!origOk.has(sp.fontName)) { let ok = false; try { ok = this._origEntries(pno, sp, "").length > 0; } catch (e) {} origOk.set(sp.fontName, ok); }
        const pred = this._predictFont(sp, origOk.get(sp.fontName));
        const sh = (r) => [rd(r[0] - ox), rd(r[1] - oy), rd(r[2] - ox), rd(r[3] - oy)];
        out.push({
          id: sp.id, text: sp.text, bbox: sh(bbox), tbox: sh(tbox),
          origin: [rd(ink[0].origin[0] - ox), rd(ink[0].origin[1] - oy)],
          size: rd(sp.size), color: hex(sp.color), font: sp.font.replace(/^[A-Z]{6}\+/, ""), family: sp.info.display,
          bold: sp.bold, italic: sp.italic, serif: sp.serif, mono: sp.mono,
          editable: !!rdir(l.dir) && !/GlyphLess/i.test(sp.fontName), ocr: /GlyphLess/i.test(sp.fontName), garbled: sp.text.includes("\ufffd"),
          displayDir: [rd(l.dir[0]), rd(l.dir[1])],
          matchedFont: pred.label, fontKind: pred.kind, exact: ["exact", "embedded", "free"].includes(pred.kind),
          compatLabel: pred.compatLabel || null, previewId: pred.previewId,
          align: amap.get(sp.id) || "left",
        });
      }
    }
    return out;
  }

  /** Removal rectangle for chars[i0:i1] (baseline band only, so neighbour lines are safe). */
  _band(l, chars, i0, i1, size) {
    const d = rdir(l.dir);
    if (!d) throw new EditError("This text is tilted and cannot be edited");
    const [dx, dy] = d, up = [dy, -dx];
    const o = chars[i0].origin;
    const proj = (c) => {
      const r = c.bbox;
      const ts = [[r[0], r[1]], [r[2], r[3]]].map((p) => (p[0] - o[0]) * dx + (p[1] - o[1]) * dy);
      return [Math.min(...ts), Math.max(...ts)];
    };
    const [t0a, t0b] = proj(chars[i0]), [t1a, t1b] = proj(chars[i1 - 1]);
    const t0 = t0a + 0.15 * (t0b - t0a), t1 = t1b - 0.15 * (t1b - t1a);
    const pts = [];
    for (const t of [t0, t1]) for (const u of [-0.08 * size, 0.6 * size]) pts.push([o[0] + t * dx + u * up[0], o[1] + t * dy + u * up[1]]);
    const rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    return { rect, origin: o, dir: d, extent: [t0a, t1b] };
  }

  /** Length along the line of characters i0..i1-1 (start of the first to end of the last). */
  _extent(l, chars, i0, i1) {
    const d = rdir(l.dir) || [1, 0], o = chars[i0].origin;
    const t = (p) => (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1];
    const last = chars[i1 - 1].bbox;
    return Math.max(t([last[0], last[1]]), t([last[2], last[3]])) - Math.min(0, t([chars[i0].bbox[0], chars[i0].bbox[1]]));
  }

  _findSpan(pno, id) {
    for (const l of this._lines(pno)) for (const sp of l.spans) if (sp.id === id) return { l, sp };
    return null;
  }

  /* -------------------------------------------------- operations */
  async editSpan(pno, spanId, expected, newText, o = {}) {
    const s = this._need();
    const t = this._findSpan(pno, spanId);
    if (!t || t.sp.text !== expected) throw new EditError("The page changed: click the text again");
    const { l, sp } = t;
    const auto = this._alignMap(this._lines(pno)).get(spanId) || "left";
    let align = o.align;
    const realign = ["left", "right", "center"].includes(align) && align !== auto;
    if (!["left", "right", "center"].includes(align)) align = auto;
    const chars = sp.chars;
    let i0 = 0;
    while (i0 < chars.length && isSpace(chars[i0].c)) i0++;
    let i1 = chars.length;
    while (i1 > i0 && isSpace(chars[i1 - 1].c)) i1--;
    const old = sp.text.slice(i0, i1);
    newText = String(newText).replace(/\r/g, "");
    const styled = realign || ["fontKey", "size", "color", "bold", "italic"].some((k) => o[k] != null);
    if (newText === old && !styled && !Number(o.dx) && !Number(o.dy)) return { ...this.info(), changed: [], font: null };
    const band = this._band(l, chars, i0, i1, sp.size);
    let size = o.size ? Number(o.size) : sp.size;
    const color = o.color || sp.color;
    let fontRes = null;
    if (newText.trim()) fontRes = await this.resolveFont(sp, newText, o.fontKey, o.bold, o.italic);
    this._checkpoint();
    this._redactPage(pno, [band.rect]);
    if (fontRes) {
      if (o.fit) {
        const w = Math.max(...newText.split("\n").map((ln) => this._runs(fontRes.fonts, ln).reduce((a, r) => a + r.adv, 0) * size));
        const width = band.extent[1] - band.extent[0];
        if (w > width && width > 0) size = Math.max(size * width / w, size * 0.5);
      }
      const mdx = Number(o.dx) || 0, mdy = Number(o.dy) || 0;     // edited AND moved in one step
      this._drawText(s.doc.loadPage(pno), [band.origin[0] + mdx, band.origin[1] + mdy], band.dir, newText, fontRes, size, color, align, band.extent);
    }
    await this._changed([pno]);
    return { ...this.info(), changed: [pno], font: fontRes && fontRes.label, fontKind: fontRes && fontRes.kind,
             exact: !!fontRes && fontRes.kind === "exact", mixed: fontRes ? fontRes.mixed : 0, size: rd(size), align,
             installed: fontRes ? fontRes.installed : [] };
  }

  _width(font, line, size) {
    let w = 0;
    for (const ch of line) { let g = font.encodeCharacter(ch.codePointAt(0)); if (!g && isSpace(ch)) g = font.encodeCharacter(32); w += font.advanceGlyph(g) * size; }
    return w;
  }

  _matcher(query, matchCase, wholeWord) {
    let pat = norm(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (wholeWord) pat = "(?<![\\p{L}\\p{N}_])" + pat + "(?![\\p{L}\\p{N}_])";
    return new RegExp(pat, "gu" + (matchCase ? "" : "i"));
  }

  find(query, matchCase, wholeWord) {
    const s = this._need();
    if (!query) return [];
    const rx = this._matcher(query, matchCase, wholeWord);
    const hits = [];
    for (let pno = 0; pno < s.doc.countPages(); pno++) {
      const [ox, oy] = this._offset(s.doc.loadPage(pno));
      for (const l of this._lines(pno)) {
        const chars = l.spans.flatMap((sp) => sp.chars);
        const text = l.spans.map((sp) => sp.text).join("");
        for (const m of text.matchAll(rx)) {
          if (!m[0].length) continue;
          let r = chars[m.index].bbox;
          for (const c of chars.slice(m.index, m.index + m[0].length)) r = union(r, c.bbox);
          hits.push({ page: pno, bbox: [rd(r[0] - ox), rd(r[1] - oy), rd(r[2] - ox), rd(r[3] - oy)] });
        }
      }
    }
    return hits;
  }

  /** Replace every match, or only the k-th match of a page (only = [page, k], in find() order). */
  async replaceAll(query, repl, matchCase, wholeWord, only) {
    const s = this._need();
    if (!query) throw new EditError("Nothing to search for");
    const rx = this._matcher(query, matchCase, wholeWord);
    const plan = [];
    let total = 0, skipped = 0;
    for (let pno = 0; pno < s.doc.countPages(); pno++) {
      if (only && pno !== only[0]) continue;
      const lines = this._lines(pno);
      const amap = this._alignMap(lines);
      const ops = [];
      let k = -1;
      for (const l of lines) {
        const texts = l.spans.map((sp) => sp.text);
        const starts = [];
        let pos = 0;
        for (const t of texts) { starts.push(pos); pos += t.length; }
        const per = new Map();
        for (const m of texts.join("").matchAll(rx)) {
          if (!m[0].length) continue;
          k++;
          if (only && k !== only[1]) continue;
          let si = 0;
          for (let i = 0; i < starts.length; i++) if (starts[i] <= m.index) si = i;
          const a = m.index - starts[si], z = a + m[0].length;
          if (z > texts[si].length || !rdir(l.dir)) { skipped++; continue; }
          if (!per.has(si)) per.set(si, []);
          per.get(si).push([a, z]);
        }
        for (const [si, ms] of per) {
          const sp = l.spans[si], text = texts[si], chars = sp.chars;
          const align = amap.get(sp.id) || "left";
          // Preferred: redraw only the matched characters, so nothing else on the line is touched
          // (other text keeps its exact glyphs, borders drawn as text stay borders). Possible when
          // nothing but spaces follows the match, or when the replacement has the same width.
          const first = chars.findIndex((c) => !isSpace(c.c));
          const local = ms.map(([a, z]) => {
            const tailEmpty = !text.slice(z).trim(), whole = a <= first && tailEmpty;
            const al = whole ? align : tailEmpty && align === "right" ? "right" : "left";
            const band = this._band(l, chars, a, z, sp.size);
            band.origin = chars[a].origin;          // start exactly where the replaced text started
            return { band, tail: repl, sp, align: al, width: this._extent(l, chars, a, z), tailEmpty };
          });
          let i0 = ms[0][0];
          if (align !== "left") i0 = Math.min(first < 0 ? i0 : first, i0);
          let i1 = chars.length;
          while (i1 > Math.max(i0, ms[ms.length - 1][1]) && isSpace(chars[i1 - 1].c)) i1--;
          let out = "", cur = i0;
          for (const [a, z] of ms) { out += text.slice(cur, a) + repl; cur = z; }
          out += text.slice(cur, i1);
          ops.push({ band: this._band(l, chars, i0, i1, sp.size), tail: out, sp, align, local });
          total += ms.length;
        }
      }
      if (ops.length) plan.push({ pno, ops });
    }
    if (!plan.length) return { ...this.info(), replaced: 0, skipped, changed: [], fonts: [] };
    for (const p of plan) {
      for (let i = 0; i < p.ops.length; i++) {
        const op = p.ops[i];
        // a single match followed only by spaces, or same-width replacements: only the matches change
        if (op.local && repl.trim()) {
          const font = await this.resolveFont(op.sp, repl);
          const w = this._runs(font.fonts, repl).reduce((a, r) => a + r.adv, 0) * op.sp.size;
          if (op.local.every((m) => m.tailEmpty && op.local.length === 1 || Math.abs(m.width - w) < 0.3)) {
            p.ops.splice(i, 1, ...op.local.map((m) => ({ ...m, font })));
            i += op.local.length - 1;
            continue;
          }
        }
        op.font = op.tail.trim() ? await this.resolveFont(op.sp, op.tail) : null;
      }
    }
    this._checkpoint();
    const fonts = new Map();
    for (const { pno, ops } of plan) {
      this._redactPage(pno, ops.map((o) => o.band.rect));
      for (const op of ops) {
        if (!op.font) continue;
        fonts.set(op.font.label, op.font.kind);
        this._drawText(s.doc.loadPage(pno), op.band.origin, op.band.dir, op.tail, op.font, op.sp.size, op.sp.color, op.align, op.band.extent);
      }
    }
    const changed = plan.map((p) => p.pno);
    await this._changed(changed);
    const installed = [...new Set(plan.flatMap((p) => p.ops.flatMap((op) => (op.font ? op.font.installed : []))))];
    return { ...this.info(), replaced: total, skipped, changed, installed,
             fonts: [...fonts].map(([label, kind]) => ({ label, kind, exact: kind === "exact" })) };
  }

  /** Move text blocks by (dx, dy) display points: items = [{id, expected}] from pageText().
   *  The original characters are really removed and redrawn at the same relative positions,
   *  with the original size, colour and (when available) font. One undo step. */
  async moveSpans(pno, items, dx, dy) {
    const s = this._need();
    dx = Number(dx) || 0; dy = Number(dy) || 0;
    if (!items || !items.length) throw new EditError("Nothing selected");
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return { ...this.info(), changed: [], moved: 0 };
    const plan = [];
    for (const it of items) {
      const t = this._findSpan(pno, it.id);
      if (!t || t.sp.text !== it.expected) throw new EditError("The page changed: select the text again");
      const { l, sp } = t;
      if (!rdir(l.dir)) throw new EditError("Tilted text cannot be moved");
      const chars = sp.chars;
      let i0 = 0; while (i0 < chars.length && isSpace(chars[i0].c)) i0++;
      let i1 = chars.length; while (i1 > i0 && isSpace(chars[i1 - 1].c)) i1--;
      if (i1 <= i0) continue;
      const kept = chars.slice(i0, i1);
      const band = this._band(l, chars, i0, i1, sp.size);
      const text = kept.map((c) => c.c).join("");
      plan.push({ sp, kept, band, font: await this.resolveFont(sp, text), color: sp.color });
    }
    if (!plan.length) return { ...this.info(), changed: [], moved: 0 };
    this._checkpoint();
    this._redactPage(pno, plan.map((p) => p.band.rect));
    for (const p of plan) this._drawChars(s.doc.loadPage(pno), p.kept, p.band.dir, [dx, dy], p.font, p.color);
    await this._changed([pno]);
    const fonts = [...new Map(plan.map((p) => [p.font.label, p.font.kind]))].map(([label, kind]) => ({ label, kind }));
    const installed = [...new Set(plan.flatMap((p) => p.font.installed || []))];
    return { ...this.info(), changed: [pno], moved: plan.length, fonts, installed };
  }

  async addText(pno, x, y, text, o = {}) {
    const s = this._need();
    if (!String(text).trim()) throw new EditError("Empty text");
    const page = s.doc.loadPage(pno);
    const [ox, oy] = this._offset(page);
    const fontRes = await this.resolveFont(null, text, o.fontKey || "b:liberationsans", !!o.bold, !!o.italic);
    this._checkpoint();
    this._drawText(s.doc.loadPage(pno), [x + ox, y + oy], [1, 0], String(text), fontRes, Number(o.size) || 12, o.color || "#000000");
    await this._changed([pno]);
    return { ...this.info(), changed: [pno], font: fontRes.label };
  }

  async erase(pno, rect, color = "#ffffff") {
    const s = this._need();
    const page = s.doc.loadPage(pno);
    const [ox, oy] = this._offset(page);
    const r = [Math.min(rect[0], rect[2]) + ox, Math.min(rect[1], rect[3]) + oy, Math.max(rect[0], rect[2]) + ox, Math.max(rect[1], rect[3]) + oy];
    if (r[2] - r[0] < 0.5 || r[3] - r[1] < 0.5) throw new EditError("Empty area");
    // Remove only the characters whose centre is under the white box (what it visibly hides):
    // one thin band through the centres of each run, so lines it merely grazes are kept.
    const bands = [];
    for (const l of this._lines(pno)) {
      let run = null;
      for (const sp of l.spans) for (const c of sp.chars) {
        const cx = (c.bbox[0] + c.bbox[2]) / 2, cy = (c.bbox[1] + c.bbox[3]) / 2;
        const inside = cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3] && !isSpace(c.c);
        if (inside) {
          if (!run) { run = [cx, cy, cx, cy]; bands.push(run); }
          else { run[0] = Math.min(run[0], cx); run[1] = Math.min(run[1], cy); run[2] = Math.max(run[2], cx); run[3] = Math.max(run[3], cy); }
        } else if (!isSpace(c.c)) run = null;
      }
    }
    this._checkpoint();
    if (bands.length) this._redactPage(pno, bands.map((b) => [b[0] - 0.3, b[1] - 0.3, b[2] + 0.3, b[3] + 0.3]), false);
    this._fillRect(s.doc.loadPage(pno), r, color);
    await this._changed([pno]);
    return { ...this.info(), changed: [pno] };
  }

  /** fill: true = exactly the rectangle (what the placing frame shows); false = proportions kept, centred */
  async addImage(pno, rect, bytes, fill = false) {
    const s = this._need();
    let img;
    try { img = new mupdf.Image(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    catch (e) { throw new EditError("This image could not be read"); }
    const page = s.doc.loadPage(pno);
    const [ox, oy] = this._offset(page);
    let [x0, y0, x1, y1] = [rect[0] + ox, rect[1] + oy, rect[2] + ox, rect[3] + oy];
    const iw = img.getWidth(), ih = img.getHeight();
    const bw = x1 - x0, bh = y1 - y0;
    let w = bw, h = bh;
    if (!fill) {                                          // keep proportions, centred in the box
      const sc = Math.min(bw / iw, bh / ih);
      w = iw * sc; h = ih * sc;
      x0 += (bw - w) / 2; y0 += (bh - h) / 2;
    }
    this._checkpoint();
    const doc = s.doc;
    const ref = doc.addImage(img);
    const p2 = doc.loadPage(pno);
    const res = pageResources(doc, p2.getObject());
    const xo = subDict(doc, res, "XObject");
    let name = "PDFEImg" + this._tok().slice(0, 5);
    xo.put(name, ref);
    const cm = M.concat([w, 0, 0, -h, x0, y0 + h], M.invert(p2.getTransform()));
    appendContent(doc, p2, `q\n${cm.map(fmt).join(" ")} cm\n/${name} Do\nQ`);
    await this._changed([pno]);
    return { ...this.info(), changed: [pno] };
  }

  async pageOp(op, pno, angle = 90, to = null) {
    const s = this._need();
    const doc = s.doc, n = doc.countPages(), t = s.tokens;
    if (!(pno >= 0 && pno < n)) throw new EditError("No such page");
    if (op === "delete" && n === 1) throw new EditError("A PDF needs at least one page");
    if (op === "move") {
      to = Math.max(0, Math.min(Number(to), n - 1));
      if (to === pno) return this.info();
    }
    this._checkpoint();
    if (op === "rotate") {
      const pobj = doc.loadPage(pno).getObject();
      const cur = pobj.getInheritable("Rotate");
      const r = ((cur && !cur.isNull() ? cur.asNumber() : 0) + Number(angle)) % 360;
      pobj.put("Rotate", (r + 360) % 360);
      t[pno] = this._tok();
    } else if (op === "delete") {
      doc.deletePage(pno);
      t.splice(pno, 1);
    } else if (op === "move") {
      const order = [...Array(n).keys()];
      order.splice(to, 0, order.splice(pno, 1)[0]);
      doc.rearrangePages(order);
      t.splice(to, 0, t.splice(pno, 1)[0]);
    } else if (op === "blank") {
      const b = doc.loadPage(pno).getBounds();
      const obj = doc.addPage([0, 0, b[2] - b[0], b[3] - b[1]], 0, {}, "");
      doc.insertPage(pno + 1, obj);
      t.splice(pno + 1, 0, this._tok());
    } else if (op === "duplicate") {
      const copy = new mupdf.PDFDocument(doc.saveToBuffer("regenerate-id=no"));
      doc.graftPage(pno + 1, copy, pno);
      t.splice(pno + 1, 0, this._tok());
    } else {
      s.undo.pop();
      throw new EditError("Unknown page operation");
    }
    s.textCache = new Map();
    await this._changed([]);
    return this.info();
  }

  async merge(bytes) {
    const s = this._need();
    let src;
    try { src = mupdf.Document.openDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), "application/pdf"); }
    catch (e) { throw new EditError("That file could not be read as a PDF"); }
    if (src.needsPassword()) throw new EditError("That PDF is password-protected");
    src = src.asPDF();
    this._checkpoint();
    const map = s.doc.newGraftMap();
    const n = src.countPages();
    for (let i = 0; i < n; i++) { map.graftPage(-1, src, i); s.tokens.push(this._tok()); }
    await this._changed([]);
    return { ...this.info(), added: n };
  }

  /** Final, compact PDF: fonts added by the editor are subset to the characters used. */
  /** Make the PDF smaller. Large photos and scans are re-encoded as JPEG at a lower resolution
   *  (the main reason PDFs are heavy); text, vector drawings and small images are not touched.
   *  level "smaller": at most 2200 px on the long side (about 200 dpi on A4), JPEG quality 80;
   *  "smallest": 1400 px (about 120 dpi), quality 65. One undo step. -> {before, after, images} */
  async reduceSize(level = "smaller") {
    const s = this._need();
    const maxSide = level === "smallest" ? 1400 : 2200, quality = level === "smallest" ? 65 : 80;
    const before = this.export().length;
    const doc = s.doc;
    const nm = (o) => { try { return o && o.isName() ? o.asName() : null; } catch (e) { return null; } };
    // images used as soft masks (transparency) stay lossless
    const smasks = new Set(), images = [];
    const n = doc.countObjects();
    for (let i = 1; i < n; i++) {
      let o;
      try { o = doc.newIndirect(i); if (!o.isStream() || nm(o.get("Subtype")) !== "Image") continue; } catch (e) { continue; }
      images.push(o);
      const sm = o.get("SMask");
      if (sm && sm.isIndirect()) smasks.add(sm.asIndirect());
    }
    this._checkpoint();
    let changed = 0;
    for (const o of images) {
      try {
        if (smasks.has(o.asIndirect())) continue;
        const im = o.get("ImageMask"), mk = o.get("Mask"), bpc = o.get("BitsPerComponent");
        if ((im && im.isBoolean() && im.asBoolean()) || (mk && mk.isArray())) continue;     // stencils, colour-key masks
        if (bpc && bpc.isNumber() && bpc.asNumber() < 8) continue;                         // 1-bit scans: already compact
        const rawLen = o.readRawStream().asUint8Array().length;    // read at once: the view is lost when memory grows
        if (rawLen < 80 * 1024) continue;                                                  // small images: not worth it
        const img = doc.loadImage(o);
        const w = img.getWidth(), h = img.getHeight();
        const k = Math.min(1, maxSide / Math.max(w, h));
        const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
        const base = img.toPixmap();
        const gray = base.getNumberOfComponents() - (base.getAlpha() ? 1 : 0) === 1;
        const cs = gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
        const plain = new mupdf.Image(base);                                               // without its mask
        const pix = new mupdf.Pixmap(cs, [0, 0, nw, nh], false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(M.identity, pix);
        dev.fillImage(plain, [nw, 0, 0, nh, 0, 0], 1);
        dev.close(); dev.destroy();
        const jpg = pix.asJPEG(quality, false);
        const bytes = (jpg.asUint8Array ? jpg.asUint8Array() : jpg).slice();
        pix.destroy(); plain.destroy(); base.destroy(); img.destroy();
        if (bytes.length > rawLen * 0.85) continue;                                        // no real gain
        o.writeRawStream(bytes);
        o.put("Filter", doc.newName("DCTDecode"));
        o.put("Width", nw); o.put("Height", nh); o.put("BitsPerComponent", 8);
        o.put("ColorSpace", doc.newName(gray ? "DeviceGray" : "DeviceRGB"));
        for (const key of ["DecodeParms", "Decode", "Intent"]) o.delete(key);
        changed++;
      } catch (e) { /* an image this engine cannot read: left as it is */ }
    }
    if (changed) await this._changed([...Array(doc.countPages()).keys()]);
    else this._dropCheckpoint();                 // nothing to compress: no undo step
    const after = this.export().length;
    return { ...this.info(), before, after, images: changed, changed: changed ? [...Array(doc.countPages()).keys()] : [] };
  }



  /* -------------------------------------------------- deleting items: lines of text (stamps, watermarks), pictures */
  /** The glyphs that draw a line of text (pageText id), as the glyph snapshot sees them. */
  _spanGlyphs(pno, id, snap) {
    const line = this._lines(pno).flatMap((l) => l.spans).find((x) => x.id === id);
    if (!line) return [];
    const out = [];
    for (const c of line.chars) {
      if (isSpace(c.c)) continue;
      const name = c.font.getName();
      const g = snap.find((g) => g.font === name && Math.abs(g.x - c.origin[0]) < 0.05 && Math.abs(g.y - c.origin[1]) < 0.05);
      if (g) out.push(g);
    }
    return out;
  }

  /** Other lines that belong with this one: the rest of a stamp or watermark (text that cannot be edited,
   *  same font, size and colour on the page), and the same text at the same place on other pages.
   *  -> {group: [ids on this page], pages: [{page, ids}] (other pages)} */
  similarText(pno, id) {
    const s = this._need();
    const all = this.pageText(pno), sp = all.find((x) => x.id === id);
    if (!sp) return { group: [], pages: [] };
    const same = (a, b) => a.font === b.font && Math.abs(a.size - b.size) < 0.1 && a.color === b.color && a.editable === b.editable;
    const group = sp.editable ? [sp] : all.filter((x) => same(x, sp));
    const pages = [];
    for (let q = 0; q < s.doc.countPages(); q++) {
      if (q === pno) continue;
      const other = this.pageText(q), ids = [];
      for (const g of group) {
        const cx = (g.bbox[0] + g.bbox[2]) / 2, cy = (g.bbox[1] + g.bbox[3]) / 2;
        // a stamp often carries a date or a name that differs a little: same place, size and look is enough
        const m = other.find((o) => same(o, g) && Math.abs((o.bbox[0] + o.bbox[2]) / 2 - cx) < 3 && Math.abs((o.bbox[1] + o.bbox[3]) / 2 - cy) < 3 &&
          (o.text === g.text || !g.editable));
        if (m) ids.push(m.id);
      }
      if (ids.length === group.length) pages.push({ page: q, ids });
    }
    return { group: group.map((g) => g.id), pages };
  }

  /** Delete lines of text, whatever their angle (a tilted watermark too). items: [{page, ids}].
   *  Only those letters go: the text, pictures and drawings around them are kept. One undo step. */
  async removeText(items) {
    const s = this._need();
    const plan = [];
    for (const { page, ids } of items || []) {
      if (!(page >= 0 && page < s.doc.countPages())) continue;
      const snap = this._glyphSnapshot(page);
      const glyphs = ids.flatMap((id) => this._spanGlyphs(page, id, snap));
      if (glyphs.length) plan.push({ page, glyphs });
    }
    if (!plan.length) throw new EditError("Nothing to delete");
    this._checkpoint();
    for (const { page, glyphs } of plan) {
      const rects = glyphs.map((g) => { const c = glyphCentre(g); return [c[0] - 0.05, c[1] - 0.05, c[0] + 0.05, c[1] + 0.05]; });
      this._redactPage(page, rects, true, new Set(glyphs.map((g) => g.key)));
    }
    const changed = plan.map((p) => p.page);
    await this._changed(changed);
    return { ...this.info(), changed, removed: plan.reduce((a, p) => a + p.glyphs.length, 0) };
  }

  /** The pictures a page draws: [{id, bbox}] (bbox like pageText's), the biggest last. */
  pageImages(pno) {
    const s = this._need(), page = s.doc.loadPage(pno), [ox, oy] = this._offset(page);
    const out = [];
    try {
      const dev = new mupdf.Device({ fillImage(img, ctm) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        out.push({ raw: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], w: img.getWidth(), h: img.getHeight() });
      } });
      page.run(dev, M.identity); dev.close();
    } catch (e) {}
    return out.map((im, i) => ({ id: i, bbox: [im.raw[0] - ox, im.raw[1] - oy, im.raw[2] - ox, im.raw[3] - oy].map(rd), raw: im.raw, w: im.w, h: im.h }));
  }

  /** The same picture at the same place on other pages (a logo, a watermark picture). -> [page] */
  similarImages(pno, id) {
    const im = this.pageImages(pno).find((x) => x.id === id);
    if (!im) return [];
    const out = [];
    for (let q = 0; q < this.s.doc.countPages(); q++) {
      if (q === pno) continue;
      if (this.pageImages(q).some((o) => o.w === im.w && o.h === im.h && o.bbox.every((v, k) => Math.abs(v - im.bbox[k]) < 2))) out.push(q);
    }
    return out;
  }

  /** Delete pictures. items: [{page, id}] for this page, or {page, like: {w, h, bbox}} on other pages.
   *  Refused, with nothing changed, when another picture would go with it (one lying under it). */
  async removeImages(items) {
    const s = this._need();
    const work = [];
    for (const it of items || []) {
      const list = this.pageImages(it.page);
      const im = it.like ? list.find((o) => o.w === it.like.w && o.h === it.like.h && o.bbox.every((v, k) => Math.abs(v - it.like.bbox[k]) < 2)) : list.find((x) => x.id === it.id);
      if (im) work.push({ page: it.page, im, count: list.length });
    }
    if (!work.length) throw new EditError("Nothing to delete");
    const keep = s.doc.saveToBuffer("regenerate-id=no").asUint8Array().slice();
    this._checkpoint();
    for (const { page, im, count } of work) {
      const pg = s.doc.loadPage(page);
      const cx = (im.raw[0] + im.raw[2]) / 2, cy = (im.raw[1] + im.raw[3]) / 2;
      const a = pg.createAnnotation("Redact");
      a.setRect([cx - 0.05, cy - 0.05, cx + 0.05, cy + 0.05]);
      pg.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_NONE);
      const after = this.pageImages(page);
      const gone = after.length < count && !after.some((o) => o.w === im.w && o.h === im.h && o.bbox.every((v, k) => Math.abs(v - im.bbox[k]) < 0.5));
      if (!gone || after.length !== count - 1) {
        this._reload(keep); this._dropCheckpoint();
        throw new EditError(gone ? "This picture lies over another one: deleting it would remove both. Use Whiteout or Redact instead." : "This picture could not be deleted");
      }
    }
    const changed = [...new Set(work.map((w) => w.page))];
    s.textCache = new Map();
    await this._changed(changed);
    return { ...this.info(), changed, removed: work.length };
  }

  /* -------------------------------------------------- tools: redact, split, convert, protect, stamps, OCR */
  /** Redact for good: what is under each box (text, pictures, drawings) is removed from the file and
   *  a black box drawn. areas: [{page, rect: [x0, y0, x1, y1]}] in page coordinates. One undo step. */
  async redact(areas) {
    const s = this._need();
    const by = new Map();
    for (const a of areas || []) {
      if (!(a.page >= 0 && a.page < s.doc.countPages())) continue;
      const [ox, oy] = this._offset(s.doc.loadPage(a.page)), r = a.rect;
      const rr = [Math.min(r[0], r[2]) + ox, Math.min(r[1], r[3]) + oy, Math.max(r[0], r[2]) + ox, Math.max(r[1], r[3]) + oy];
      if (rr[2] - rr[0] < 0.5 || rr[3] - rr[1] < 0.5) continue;
      if (!by.has(a.page)) by.set(a.page, []);
      by.get(a.page).push(rr);
    }
    if (!by.size) throw new EditError("Nothing to redact");
    this._checkpoint();
    for (const [pno, rects] of by) this._redactOnly(pno, rects, true);
    const changed = [...by.keys()];
    await this._changed(changed);
    return { ...this.info(), changed, redacted: [...by.values()].reduce((a, r) => a + r.length, 0) };
  }

  /** New PDFs made of some pages (the open document is not changed). parts: [[0, 1], [2]] -> [bytes] */
  extract(parts) {
    const s = this._need();
    const base = new mupdf.PDFDocument(this.export());
    const n = base.countPages();
    const info = base.getTrailer().get("Info");
    return parts.map((pages) => {
      if (!pages.length) throw new EditError("No page chosen");
      const out = new mupdf.PDFDocument();
      const map = out.newGraftMap();
      for (const p of pages) { if (!(p >= 0 && p < n)) throw new EditError("No such page"); map.graftPage(-1, base, p); }
      if (info && !info.isNull()) out.getTrailer().put("Info", map.graftObject(info));    // same title, author…
      return untraced(out.saveToBuffer("garbage=deduplicate,compress").asUint8Array().slice(), s.version);
    });
  }

  /** Pages as pictures: [{page, bytes}], PNG or JPEG, 72 to 300 dpi. */
  toImages(format = "png", dpi = 150, pages = null) {
    const s = this._need();
    const list = pages && pages.length ? pages : [...Array(s.doc.countPages()).keys()];
    const sc = Math.max(72, Math.min(Number(dpi) || 150, 300)) / 72;
    return list.map((p) => {
      const pix = s.doc.loadPage(p).toPixmap(M.scale(sc, sc), mupdf.ColorSpace.DeviceRGB, false, true);
      const b = format === "jpg" ? pix.asJPEG(90, false) : pix.asPNG();
      const bytes = (b.asUint8Array ? b.asUint8Array() : b).slice();
      pix.destroy();
      return { page: p, bytes };
    });
  }

  /** A page as a grey PNG, for text recognition. */
  pagePng(pno, dpi = 300) {
    const s = this._need();
    const sc = Math.max(72, Math.min(Number(dpi) || 300, 400)) / 72;
    const pix = s.doc.loadPage(pno).toPixmap(M.scale(sc, sc), mupdf.ColorSpace.DeviceGray, false, true);
    const b = pix.asPNG(), bytes = (b.asUint8Array ? b.asUint8Array() : b).slice();
    const w = pix.getWidth(), h = pix.getHeight();
    pix.destroy();
    return { bytes, w, h };
  }

  /** Pages with (almost) no text: the scans worth recognising. */
  textlessPages() {
    const s = this._need(), out = [];
    for (let p = 0; p < s.doc.countPages(); p++) {
      const t = s.doc.loadPage(p).toStructuredText("preserve-whitespace").asText().replace(/\s+/g, "");
      if (t.length < 20) out.push(p);
    }
    return out;
  }

  /** The text, page after page. */
  toText() {
    const s = this._need(), out = [];
    for (let p = 0; p < s.doc.countPages(); p++) out.push(s.doc.loadPage(p).toStructuredText("preserve-whitespace").asText().replace(/\s+$/, ""));
    return out.join("\n\f\n") + "\n";
  }

  /** A Word document (.docx): the text in reading order, one paragraph per block, with its size,
   *  bold and italic, and a page break between pages. Layout, pictures and tables are not kept. */
  toDocx() {
    const s = this._need();
    const esc = (t) => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const n = s.doc.countPages();
    let body = "";
    for (let p = 0; p < n; p++) {
      const j = JSON.parse(s.doc.loadPage(p).toStructuredText("preserve-whitespace").asJSON());
      for (const blk of j.blocks || []) {
        if (blk.type !== "text" || !blk.lines) continue;
        let runs = "";
        blk.lines.forEach((ln, i) => {
          const f = ln.font || {};
          let t = String(ln.text || "").replace(/\s+$/, "");
          if (!t) return;
          const next = blk.lines[i + 1];
          if (next) t = /[-\u00ad]$/.test(t) ? t.replace(/[-\u00ad]$/, "") : t + " ";      // re-join hyphenated lines
          const font = String(f.name || "").replace(/^[A-Z]{6}\+/, "").replace(/[-,](Bold|Italic|Oblique|Regular|BoldItalic|MT|PS)+$/i, "").replace(/MT$|PSMT$/, "");
          const bold = f.weight === "bold" || /bold|black|heavy/i.test(f.name || ""), italic = f.style === "italic" || /italic|oblique/i.test(f.name || "");
          const sz = Math.max(2, Math.round((f.size || 11) * 2));
          runs += `<w:r><w:rPr>${font ? `<w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:cs="${esc(font)}"/>` : ""}${bold ? "<w:b/>" : ""}${italic ? "<w:i/>" : ""}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
        });
        if (runs) body += `<w:p>${runs}</w:p>`;
      }
      if (p < n - 1) body += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
    }
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    return makeZip([
      { name: "[Content_Types].xml", bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
      { name: "_rels/.rels", bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: "word/document.xml", bytes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>` },
    ]);
  }

  /** A copy that needs a password to open (AES-256). The open document is not changed. */
  protect(password, allowPrint = true, allowCopy = false) {
    this._need();
    password = String(password || "");
    if (password.length < 4) throw new EditError("Choose a password of at least 4 characters");
    if (password.includes(",")) throw new EditError("The password cannot contain a comma");
    // permission bits (ISO 32000, table 22): 3 print, 4 modify, 5 copy, 11 assemble, 12 high-quality print
    let perm = -1 & ~8 & ~1024;
    if (!allowCopy) perm &= ~16;
    if (!allowPrint) perm &= ~(4 | 2048);
    const owner = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const doc = new mupdf.PDFDocument(this.export());
    const out = doc.saveToBuffer(`encrypt=aes-256,user-password=${password},owner-password=${owner},permissions=${perm},garbage=deduplicate,compress,regenerate-id=no`).asUint8Array().slice();
    return untraced(out, null);                     // AES-256 needs PDF 1.7+: the version is not lowered
  }

  /** Page numbers. o: {format: "{n}" | "{n} / {total}" | "Page {n} of {total}" (already translated),
   *  position: "bottom-center" | "bottom-right" | "bottom-left" | "top-right", size, start, skipFirst}. */
  async pageNumbers(o = {}) {
    const s = this._need();
    const n = s.doc.countPages(), first = o.skipFirst ? 1 : 0;
    if (first >= n) throw new EditError("No page to number");
    const start = Number.isFinite(+o.start) ? Math.round(+o.start) : 1, size = Math.max(5, Math.min(Number(o.size) || 10, 48));
    const format = String(o.format || "{n}"), pos = String(o.position || "bottom-center");
    const total = start + (n - first) - 1;
    const sample = format.replace(/\{n\}|\{total\}/g, "0123456789");
    const fontRes = await this.resolveFont(null, sample, "b:liberationsans", false, false);
    this._checkpoint();
    const changed = [];
    for (let p = first; p < n; p++) {
      const page = s.doc.loadPage(p), b = page.getBounds(), m = 28;
      const text = format.replace("{n}", String(start + p - first)).replace("{total}", String(total));
      const y = pos.startsWith("top") ? b[1] + m + size * 0.8 : b[3] - m;
      const align = pos.endsWith("right") ? "right" : pos.endsWith("left") ? "left" : "center";
      this._drawText(page, [b[0] + m, y], [1, 0], text, fontRes, size, o.color || "#333333", align, [0, b[2] - b[0] - 2 * m]);
      changed.push(p);
    }
    await this._changed(changed);
    return { ...this.info(), changed };
  }

  /** A watermark across every page: semi-transparent text along the diagonal. */
  async watermark(text, o = {}) {
    const s = this._need();
    text = String(text || "").replace(/\s+/g, " ").trim();
    if (!text) throw new EditError("Empty text");
    const fontRes = await this.resolveFont(null, text, "b:liberationsans", true, false);
    const chain = fontRes.fonts || [fontRes];
    const adv = this._runs(chain, text).reduce((a, r) => a + r.adv, 0) || 1;
    const opacity = Math.max(0.05, Math.min(Number(o.opacity) || 0.18, 1));
    this._checkpoint();
    const changed = [];
    for (let p = 0; p < s.doc.countPages(); p++) {
      const page = s.doc.loadPage(p), b = page.getBounds(), w = b[2] - b[0], h = b[3] - b[1];
      const a = Math.atan2(h, w), dir = [Math.cos(a), -Math.sin(a)], down = [-dir[1], dir[0]];
      const size = Math.min(Number(o.size) || 1e9, (Math.hypot(w, h) * 0.75) / adv, h / 4);
      const c = [b[0] + w / 2, b[1] + h / 2], half = (adv * size) / 2;
      const origin = [c[0] - dir[0] * half + down[0] * size * 0.35, c[1] - dir[1] * half + down[1] * size * 0.35];
      this._drawText(page, origin, dir, text, fontRes, size, o.color || "#c0392b", "left", [0, 0], opacity);
      changed.push(p);
    }
    await this._changed(changed);
    return { ...this.info(), changed };
  }

  _alphaState(page, alpha) {
    const doc = this.s.doc, res = pageResources(doc, page.getObject()), gs = subDict(doc, res, "ExtGState");
    const name = "PDFEa" + Math.round(alpha * 100);
    const cur = gs.get(name);
    if (!cur || cur.isNull()) {
      const d = doc.newDictionary();
      d.put("Type", doc.newName("ExtGState")); d.put("ca", alpha); d.put("CA", alpha);
      gs.put(name, doc.addObject(d));
    }
    return name;
  }

  /** Make scans searchable. layers: [{page, pdf}] where pdf is the one-page PDF the text recogniser
   *  made from a picture of the page (picture + invisible text). Only its invisible text is laid over
   *  the page, stretched to the page: nothing visible changes. One undo step. */
  async addTextLayer(layers) {
    const s = this._need();
    this._checkpoint();
    const changed = [];
    for (const { page: pno, pdf } of layers || []) {
      let src;
      try { src = new mupdf.PDFDocument(pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf)); } catch (e) { continue; }
      const sp = src.loadPage(0), sb = sp.getBounds(), spo = sp.getObject();
      const W = sb[2] - sb[0], H = sb[3] - sb[1];
      const ops = readContents(spo).replace(/q\s+[-\d.\s]+cm\s+\/[^\s/]+\s+Do\s+Q/g, "");      // drop the picture
      if (!/BT[\s\S]*?Tj|BT[\s\S]*?TJ/.test(ops)) continue;
      const map = s.doc.newGraftMap();
      const res = s.doc.newDictionary();
      const fonts = spo.get("Resources") && spo.get("Resources").get("Font");
      if (fonts && !fonts.isNull()) res.put("Font", map.graftObject(fonts));
      const xo = s.doc.addStream(ops, {});
      xo.put("Type", s.doc.newName("XObject")); xo.put("Subtype", s.doc.newName("Form"));
      const bbox = s.doc.newArray(); for (const v of [0, 0, W, H]) bbox.push(v); xo.put("BBox", bbox);
      xo.put("Resources", res);
      const page = s.doc.loadPage(pno), b = page.getBounds(), w = b[2] - b[0], h = b[3] - b[1];
      const cm = M.concat([w / W, 0, 0, -h / H, b[0], b[1] + h], M.invert(page.getTransform()));
      const xod = subDict(s.doc, pageResources(s.doc, page.getObject()), "XObject");
      const name = "PDFEOcr" + this._tok().slice(0, 5);
      xod.put(name, xo);
      appendContent(s.doc, page, `q\n${cm.map(fmt).join(" ")} cm\n/${name} Do\nQ`);
      changed.push(pno);
    }
    if (!changed.length) { this._dropCheckpoint(); return { ...this.info(), changed: [] }; }
    await this._changed(changed);
    return { ...this.info(), changed };
  }

  /** A new PDF from pictures (JPEG, PNG, GIF, BMP, TIFF), one page each, then opened.
   *  o.size: "a4" (fitted on A4 with margins, portrait or landscape) or "fit" (the picture's size). */
  fromImages(list, o = {}) {
    if (!list || !list.length) throw new EditError("No picture chosen");
    const out = new mupdf.PDFDocument();
    for (const im of list) {
      let img;
      try { img = new mupdf.Image(im.bytes instanceof Uint8Array ? im.bytes : new Uint8Array(im.bytes)); }
      catch (e) { throw new EditError(`“${im.name}” is not a picture this editor can read`); }
      const iw = img.getWidth(), ih = img.getHeight(), xr = img.getXResolution() || 96, yr = img.getYResolution() || 96;
      let pw, ph, w, h, x, y;
      if (o.size === "fit") { pw = w = iw * 72 / xr; ph = h = ih * 72 / yr; x = y = 0; }
      else {
        const land = iw > ih; pw = land ? 842 : 595; ph = land ? 595 : 842;
        const m = 28, sc = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
        w = iw * sc; h = ih * sc; x = (pw - w) / 2; y = (ph - h) / 2;
      }
      const ref = out.addImage(img);
      const res = out.addObject({ XObject: { Im0: ref } });
      out.insertPage(-1, out.addPage([0, 0, pw, ph], 0, res, `q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /Im0 Do Q`));
    }
    const bytes = out.saveToBuffer("garbage=deduplicate,compress").asUint8Array().slice();
    return this.open(untraced(bytes, null), o.name || "images.pdf");
  }

  /** Active content in the PDF: scripts, actions that open programs or web pages on their own,
   *  attached files, XFA forms. -> { total, kinds: { javascript, launch, ... } } */
  activeContent() {
    const s = this._need();
    return scanActive(s.doc, false);
  }
  /** Remove it (OWASP: a saved PDF must not carry a hidden attack). Text, images, links and forms
   *  stay; only what runs or opens something by itself goes. One undo step. */
  async removeActiveContent() {
    const s = this._need();
    this._checkpoint();
    const r = scanActive(s.doc, true);
    if (!r.total) { this._dropCheckpoint(); return { ...this.info(), removed: r, changed: [] }; }
    await this._changed([...Array(s.doc.countPages()).keys()]);
    return { ...this.info(), removed: r, changed: [...Array(s.doc.countPages()).keys()] };
  }

  export() {
    const s = this._need();
    const data = s.doc.saveToBuffer("regenerate-id=no").asUint8Array().slice();
    let out;
    const keepId = (d) => {
      if (!s.fileId) return;
      try { const a = d.newArray(); a.push(d.newByteString(s.fileId[0])); a.push(d.newByteString(s.fileId[1])); d.getTrailer().put("ID", a); } catch (e) {}
    };
    try {
      const copy = new mupdf.PDFDocument(data);
      copy.subsetFonts();
      keepId(copy);
      out = copy.saveToBuffer("garbage=deduplicate,compress,regenerate-id=no").asUint8Array().slice();
    } catch (e) {
      keepId(s.doc);
      out = s.doc.saveToBuffer("garbage=compact,compress,regenerate-id=no").asUint8Array().slice();
    }
    return untraced(out, s.version);
  }

  fontList() { return this.fonts.families(); }
  setLocalFonts(list) { this.fonts.addLocal(list); if (this.s) this.s.textCache = new Map(); return this.fonts.families(); }
  /** Fonts added from files: list = [{id, file, index, family, ps, bold, italic}] (bytes come from fetchBytes). */
  setUserFonts(list) { this.fonts.addUser(list); if (this.s) this.s.textCache = new Map(); return this.fonts.families(); }
  removeUserFonts(ids) { this.fonts.removeUser(ids); if (this.s) this.s.textCache = new Map(); return this.fonts.families(); }
  userFonts() { return this.fonts.userFonts(); }
  async fontBytes(id) {
    const e = this.fonts.entries.find((x) => x.id === id);
    // a copy: the result is transferred to the page, which would empty the cached bytes
    return e ? (await this.fonts.load(e)).slice() : null;
  }
  /** Font used to preview a family in the editor box. */
  previewFor(fontKey, bold, italic) {
    const kind = fontKey.startsWith("l:") ? "local" : "bundled";
    const e = this.fonts.lookup(fontKey.slice(2), !!bold, !!italic, kind);
    return e ? e.id : null;
  }
  previewForSpan(sp, bold, italic) {
    // sp: a pageText() entry; used when the user toggles bold/italic on the original font
    const info = parsePdfFont(sp.font);
    const lib = this.fonts;
    const e = lib.lookup(info.key, bold, italic, "local") || lib.lookup(info.base, bold, italic, "local")
      || (this.allowFree && lib.freeEntries(info, sp.font + (bold ? "-Bold" : ""), bold, italic)[0])
      || lib.lookup(COMPATIBLE[info.key] || COMPATIBLE[info.base] || (sp.serif ? "liberationserif" : sp.mono ? "liberationmono" : "liberationsans"), bold, italic, "bundled");
    return e ? e.id : null;
  }
}
