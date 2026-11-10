/* PDF Editor - Web Worker: runs the engine off the main thread.
 * Protocol  main -> worker: {id, op, args}         worker -> main: {id, ok, result|error}
 *           worker -> main: {req, type:"localFont", postscriptName}   main -> worker: {req, bytes|error}
 * The open document is also kept in IndexedDB (this browser only) so a reload or a
 * crash does not lose the edits. Nothing ever leaves the computer. */
import { Engine, EditError, readFontFile, makeZip } from "./engine.js?v=ca3a0544d8";

let engine = null;
let reqSeq = 0;
const pending = new Map();

function askMain(msg) {
  return new Promise((resolve, reject) => {
    const req = ++reqSeq;
    pending.set(req, { resolve, reject });
    self.postMessage({ req, ...msg });
  });
}

const userFileCache = new Map();   // fileId -> bytes (the last few font files used)
async function fetchBytes(src) {
  if (src.type === "user") {
    if (!userFileCache.has(src.file)) {
      const rec = await idbDo("readonly", (st) => st.get(src.file), FONTFILES);
      if (!rec) throw new Error("font file missing");
      userFileCache.set(src.file, rec.bytes);
      while (userFileCache.size > 12) userFileCache.delete(userFileCache.keys().next().value);
    }
    return userFileCache.get(src.file);
  }
  if (src.type === "free") {                   // free font from the font library: kept for next time
    const cached = await idbDo("readonly", (st) => st.get("free:" + src.url), FONTFILES);
    if (cached && cached.bytes) return cached.bytes;
    // only pinned files of the font library, of a sensible size, that really are fonts (OWASP A03/A08)
    if (!/^https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/[a-z0-9-]+@\d+\.\d+\.\d+\/[a-z0-9-]+\.ttf$/.test(src.url)) throw new Error("font address refused");
    const r = await fetch(src.url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "force-cache" });
    if (!r.ok) throw new Error("free font download failed");
    if (Number(r.headers.get("content-length") || 0) > 10 * 1048576) throw new Error("free font too large");
    const bytes = new Uint8Array(await r.arrayBuffer());
    const tag = String.fromCharCode(...bytes.slice(0, 4));
    if (bytes.length > 10 * 1048576 || !(tag === "\0\x01\0\0" || tag === "OTTO" || tag === "true")) throw new Error("not a font file");
    idbDo("readwrite", (st) => st.put({ name: src.url.split("/").pop(), bytes }, "free:" + src.url), FONTFILES);
    return bytes;
  }
  if (src.type === "bundled") {
    const r = await fetch(new URL("fonts/" + src.file, import.meta.url));
    if (!r.ok) throw new Error("font download failed");
    return new Uint8Array(await r.arrayBuffer());
  }
  return new Uint8Array(await askMain({ type: "localFont", postscriptName: src.postscriptName }));
}

/* ---------------- IndexedDB: last open document */
const DB = "pdf-editor", STORE = "docs", FONTFILES = "fontfiles", FONTMETA = "fontmeta";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      for (const n of [STORE, FONTFILES, FONTMETA]) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn, store = STORE) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      const out = fn(tx.objectStore(store));
      tx.oncomplete = () => res(out && out.result);
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) { return null; }   // private mode or storage disabled: just skip
}
/* Crash recovery keeps an unencrypted copy of the open PDF in this browser. It is switched off
 * while someone is signed in: their PDFs are only ever stored encrypted (My PDFs). */
let recovery = true;
const persist = (name, bytes) => (recovery ? idbDo("readwrite", (st) => st.put({ name, bytes, time: Date.now() }, "current")) : Promise.resolve());

const ready = (async () => {
  const manifest = await (await fetch(new URL("fonts/fonts.json?v=ca3a0544d8", import.meta.url))).json();
  engine = new Engine({ manifest, fetchBytes, persist });
  // the catalogue of free fonts (Google Fonts...): small, loaded in the background
  fetch(new URL("fonts/free-fonts.json", import.meta.url)).then((r) => r.json()).then((c) => engine.setFreeCatalog(c)).catch(() => {});
  const faces = await idbDo("readonly", (st) => st.get("faces"), FONTMETA);
  if (faces && faces.length) engine.setUserFonts(faces);
})();

/* ---------------- fonts added from files: kept in this browser only */
const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;
async function saveFaces() {
  const faces = engine.fonts.entries.filter((e) => e.source.type === "user").map((e) => ({
    id: e.source.id, file: e.source.file, index: e.source.index, family: e.family, ps: e.psName, bold: e.bold, italic: e.italic, size: e.size }));
  await idbDo("readwrite", (st) => st.put(faces, "faces"), FONTMETA);
}
function userFamilies() {
  const fam = new Map();
  for (const e of engine.fonts.entries) {
    if (e.source.type !== "user") continue;
    const f = fam.get(e.family) || { family: e.family, styles: 0, files: new Set(), bytes: 0 };
    f.styles++;
    if (!f.files.has(e.source.file)) { f.files.add(e.source.file); f.bytes += e.size || 0; }
    fam.set(e.family, f);
  }
  return [...fam.values()].map((f) => ({ family: f.family, styles: f.styles, files: f.files.size, bytes: f.bytes })).sort((a, b) => a.family.localeCompare(b.family));
}

const worker = {
  async open(bytes, name, password) {
    const info = engine.open(bytes, name, password);
    persist(info.name, engine.s.doc.saveToBuffer("").asUint8Array().slice());
    return info;
  },
  async restoreInfo() {
    const rec = await idbDo("readonly", (st) => st.get("current"));
    return rec ? { name: rec.name, time: rec.time, size: rec.bytes.length } : null;
  },
  async restore() {
    const rec = await idbDo("readonly", (st) => st.get("current"));
    if (!rec) throw new EditError("Nothing to restore");
    return engine.open(rec.bytes, rec.name);
  },
  /** files: File objects picked or dropped by the person. Large files are skipped when maxBytes is set. */
  async addFontFiles(files, maxBytes) {
    const added = new Set(), skipped = [], faces = [];
    let stored = 0, ignored = 0;
    const known = new Set(engine.fonts.entries.filter((e) => e.source.type === "user").map((e) => e.source.file));
    for (const f of files) {
      if (!FONT_EXT.test(f.name)) { ignored++; continue; }
      if (maxBytes && f.size > maxBytes) { skipped.push({ name: f.name, size: f.size, why: "large" }); continue; }
      const fileId = f.name + ":" + f.size;
      let bytes, list;
      try { bytes = new Uint8Array(await f.arrayBuffer()); list = readFontFile(bytes); }
      catch (e) { skipped.push({ name: f.name, size: f.size, why: e.message }); continue; }
      if (!known.has(fileId)) {
        const ok = await idbDo("readwrite", (st) => st.put({ name: f.name, bytes }, fileId), FONTFILES);
        if (ok === null) { skipped.push({ name: f.name, size: f.size, why: "the browser has no room left to keep it" }); continue; }
        known.add(fileId); stored += f.size;
      }
      for (const face of list) {
        faces.push({ id: fileId + "#" + face.index, file: fileId, index: face.index, family: face.family, ps: face.ps, bold: face.bold, italic: face.italic, size: f.size });
        added.add(face.family);
      }
    }
    if (faces.length) { engine.setUserFonts(faces); await saveFaces(); }
    return { families: [...added].sort(), skipped, ignored, stored, fonts: engine.fontList(), list: userFamilies() };
  },
  async removeFontFamilies(families) {
    const drop = new Set(families);
    const gone = engine.fonts.entries.filter((e) => e.source.type === "user" && (drop.has(e.family) || drop.has("*")));
    engine.removeUserFonts(gone.map((e) => e.source.id));
    const still = new Set(engine.fonts.entries.filter((e) => e.source.type === "user").map((e) => e.source.file));
    for (const fileId of new Set(gone.map((e) => e.source.file))) {
      if (!still.has(fileId)) { userFileCache.delete(fileId); await idbDo("readwrite", (st) => st.delete(fileId), FONTFILES); }
    }
    await saveFaces();
    return { fonts: engine.fontList(), list: userFamilies() };
  },
  async userFontFamilies() { return userFamilies(); },
  async setRecovery(on) {
    recovery = !!on;
    if (!recovery) await idbDo("readwrite", (st) => st.delete("current"));     // no plaintext copy left behind
    return true;
  },
  zip(files) { return makeZip(files); },
  async discard() { await idbDo("readwrite", (st) => st.delete("current")); engine.s = null; return true; },
};

let queue = Promise.resolve();
self.addEventListener("unhandledrejection", (e) => self.postMessage({ fatal: String(e.reason && e.reason.message || e.reason) }));
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.req) {                                    // answer to askMain
    const p = pending.get(m.req);
    pending.delete(m.req);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.bytes);
    return;
  }
  queue = queue.then(async () => {
    try {
      await ready;
      const fn = worker[m.op] || (typeof engine[m.op] === "function" && !m.op.startsWith("_") ? engine[m.op].bind(engine) : null);
      if (!fn) throw new EditError("Unknown operation " + m.op);
      const result = await fn(...(m.args || []));
      const transfer = [];
      if (result && result.pixels) transfer.push(result.pixels.buffer);
      else if (result instanceof Uint8Array) transfer.push(result.buffer);
      self.postMessage({ id: m.id, ok: true, result }, transfer);
    } catch (e) {
      if (!(e instanceof EditError)) console.error(e);
      self.postMessage({ id: m.id, ok: false, error: e instanceof EditError ? e.message : "Unexpected error: " + (e && e.message || e) });
    }
  });
};
// Messages sent before this module finished loading (the 10 MB engine is compiled at import
// time) can be lost, so the page waits for this signal before sending anything.
ready.then(() => self.postMessage({ hello: true }), (e) => self.postMessage({ fatal: "Could not load the fonts list: " + e.message }));
