/* PDF Editor - reading font files (TTF / OTF / TTC). No dependencies: used by the editor
 * (engine.js, worker.js), the account page and the server (to check uploaded fonts). */

export class FontFileError extends Error {}
const EXTRA = new Set(["light", "medium", "semibold", "demibold", "demi", "narrow", "condensed", "thin",
  "extralight", "ultralight", "semilight", "compressed", "extended"]);
export const FONT_FILE_RX = /\.(ttf|otf|ttc|otc)$/i;

/** Read the names of every font in a TTF / OTF / TTC file (no rendering, just the 'name',
 *  'head' and 'OS/2' tables). Returns [{index, family, style, ps, bold, italic, full}]. */
export function readFontFile(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length < 12) throw new FontFileError("Not a font file");
  let offsets = [0];
  if (tag(0) === "ttcf") {
    const n = dv.getUint32(8);
    if (n < 1 || n > 256) throw new FontFileError("Not a font file");
    offsets = [];
    for (let i = 0; i < n; i++) offsets.push(dv.getUint32(12 + 4 * i));
  } else if (!["\0\x01\0\0", "OTTO", "true", "typ1"].includes(tag(0))) {
    throw new FontFileError(tag(0) === "wOFF" || tag(0) === "wOF2" ? "Web fonts (.woff) are not supported: use the .ttf or .otf file" : "Not a TrueType or OpenType font");
  }
  const out = [];
  offsets.forEach((base, index) => {
    const numTables = dv.getUint16(base + 4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const r = base + 12 + 16 * i;
      tables[tag(r)] = { off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) };
    }
    const names = {};
    const nt = tables.name;
    if (nt) {
      const count = dv.getUint16(nt.off + 2), strOff = nt.off + dv.getUint16(nt.off + 4);
      for (let i = 0; i < count; i++) {
        const r = nt.off + 6 + 12 * i;
        const plat = dv.getUint16(r), enc = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6);
        const len = dv.getUint16(r + 8), o = strOff + dv.getUint16(r + 10);
        if (![1, 2, 4, 6, 16, 17].includes(id) || o + len > u8.length) continue;
        let s = null, score = 0;
        if (plat === 3 || plat === 0) {                     // UTF-16BE
          s = ""; for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(o + k));
          score = plat === 3 && (lang === 0x409 || lang === 0) ? 3 : 2;
        } else if (plat === 1 && enc === 0) {               // Mac Roman, close enough for names
          s = ""; for (let k = 0; k < len; k++) s += String.fromCharCode(u8[o + k]);
          score = lang === 0 ? 1 : 0;
        }
        if (s && (!names[id] || names[id].score < score)) names[id] = { s: s.replace(/\0/g, "").trim(), score };
      }
    }
    const nm = (id) => (names[id] && names[id].s) || "";
    const family = nm(16) || nm(1), style = nm(17) || nm(2) || "Regular";
    if (!family) return;
    let bold = /bold|black|heavy/i.test(style) && !/semi|demi/i.test(style) ? true : /semibold|demibold/i.test(style);
    let italic = /italic|oblique/i.test(style);
    if (tables.head && tables.head.len >= 46) {
      const mac = dv.getUint16(tables.head.off + 44);
      bold = bold || !!(mac & 1); italic = italic || !!(mac & 2);
    }
    if (tables["OS/2"] && tables["OS/2"].len >= 64) {
      const sel = dv.getUint16(tables["OS/2"].off + 62), weight = dv.getUint16(tables["OS/2"].off + 4);
      italic = italic || !!(sel & 1);
      if (sel & 32) bold = true;
      if (weight >= 600) bold = true;
    }
    // light/medium/narrow... variants: keep them as their own family ("Aptos Light"), like the PDF names do
    const st = style.toLowerCase().replace(/\b(semi|demi|extra|ultra)\s+(bold|light)\b/g, "$1$2");
    const extra = st.split(/\s+/).filter((t) => EXTRA.has(t) && !["semibold", "demibold", "demi"].includes(t));
    const fam = extra.length && !family.toLowerCase().includes(extra[0]) ? `${family} ${extra.map((t) => t[0].toUpperCase() + t.slice(1)).join(" ")}` : family;
    out.push({ index, family: fam, style, ps: nm(6) || fam + "-" + style, full: nm(4) || `${fam} ${style}`, bold, italic });
  });
  if (!out.length) throw new FontFileError("This font has no readable name");
  return out;
}

