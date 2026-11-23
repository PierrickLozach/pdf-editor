/* PDF Editor - the document editor (/write/): Word (.docx) and LibreOffice (.odt) documents.
 * The word processor is EdenText (AGPL, by Steffen Becker), served unmodified from this site in
 * ./edentext/ and shown in a frame in its embed mode: it keeps nothing itself and this page owns the
 * file, as in the PDF editor:
 *  - Open, drop, Recent files (Chrome, Edge: the file itself, so Save writes back into it)
 *  - Save: into the opened file, else a new file the person picks, else a download (Firefox, Safari)
 *  - Download copy: Word, LibreOffice or PDF, the file opened is not changed
 *  - an unsaved copy is kept in this browser while there are changes, offered again on the start screen
 *  - the language of the site; the AI assistant and dictation of EdenText are off (they would send the
 *    text or the voice to another service), and the site's headers allow no connection to another site.
 * Everything stays in the browser: nothing is uploaded. */
import { EdenTextFrame } from "./edentext/embed.js";

const t = (s) => (window.I18N ? I18N.t(s) : s);
const tf = (s, v) => t(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const $ = (s) => document.querySelector(s);
const STORE = window.DOCSTORE;
const FS = typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
const TYPES = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx", label: "Word document" },
  odt: { mime: "application/vnd.oasis.opendocument.text", ext: ".odt", label: "LibreOffice document" },
  pdf: { mime: "application/pdf", ext: ".pdf", label: "PDF document" },
};
const OPEN_TYPES = [{ description: "Word or LibreOffice document", accept: {
  [TYPES.docx.mime]: [".docx"], "application/vnd.openxmlformats-officedocument.wordprocessingml.template": [".dotx"],
  [TYPES.odt.mime]: [".odt"], "application/vnd.oasis.opendocument.text-template": [".ott"] } }];
// the site's languages that EdenText 0.15.0 speaks; the others get its English (Dutch, Hebrew, and Arabic, which comes after 0.15.0)
const LOCALES = { en: "en", fr: "fr", es: "es", pt: "pt", de: "de", it: "it", pl: "pl", ja: "ja", zh: "zh-Hans" };
const RECENT_KEEP = 10, RECENT_SHOW = 5, COPY_EVERY = 15000;

/** state of the open document */
const S = { open: false, name: "", fmt: "docx", template: false, handle: null, edDirty: false, hostDirty: false, recentId: null, copyHash: "" };
const dirty = () => S.open && (S.edDirty || S.hostDirty);
const base = (n) => n.replace(/\.(docx|dotx|odt|ott)$/i, "");
const kindOf = (name) => {
  const m = /\.(docx|dotx|odt|ott)$/i.exec(name || "");
  if (!m) return null;
  const e = m[1].toLowerCase();
  return { fmt: e === "docx" || e === "dotx" ? "docx" : "odt", template: e === "dotx" || e === "ott" };
};
const stats = (e) => window.PDFE_STATS && PDFE_STATS.event(e);

/* ---------------------------------------------------------------- small interface helpers */
let toastTimer = 0;
function toast(msg, error) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", !!error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), error ? 6000 : 3000);
}
/** A question with buttons: [[value, label, primary?]] → the value clicked (Escape: null). */
function ask(title, text, buttons) {
  const m = $("#modal"), acts = $("#modalActions");
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  acts.textContent = "";
  return new Promise((done) => {
    const finish = (v) => { m.hidden = true; document.removeEventListener("keydown", key, true); done(v); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } };
    for (const [v, label, primary] of buttons) {
      const b = document.createElement("button");
      b.textContent = label;
      if (primary) b.className = "primary";
      b.onclick = () => finish(v);
      acts.appendChild(b);
    }
    document.addEventListener("keydown", key, true);
    m.hidden = false;
    (acts.querySelector(".primary") || acts.querySelector("button")).focus();
  });
}
async function busy(fn) {
  document.body.classList.add("busy");
  try { return await fn(); }
  catch (e) { if (e && e.name === "AbortError") return; console.error(e); toast(tf("Something went wrong: {m}", { m: (e && e.message) || e }), true); }
  finally { document.body.classList.remove("busy"); }
}
function show() {
  document.body.classList.toggle("has-doc", S.open);
  $("#frameWrap").setAttribute("aria-hidden", S.open ? "false" : "true");
  $("#docName").textContent = S.open ? S.name : t("Document editor");
  $("#homeLink").title = S.open ? S.name : t("Home page");
  const st = $("#saveState");
  st.hidden = !S.open;
  st.textContent = dirty() ? t("Not saved") : S.handle ? t("Saved") : "";
  st.classList.toggle("dirty", dirty());
  $("#btnSave").querySelector("span").textContent = S.open && S.handle ? t("Save (overwrites)") : t("Save");
  $("#btnSave").title = S.open && S.handle ? tf("Save into “{name}” (⌘S / Ctrl+S)", { name: S.name }) : t("Save the document (⌘S / Ctrl+S)");
  document.title = S.open ? (dirty() ? "• " : "") + S.name + " – " + t("Document editor") : t("Document editor");
}

/* ---------------------------------------------------------------- the word processor */
const frame = new EdenTextFrame($("#frameWrap"), {
  locale: LOCALES[(window.I18N && I18N.lang) || "en"] || "en",
  theme: "auto", accent: "#e5322d", ai: false, dictation: false,
});
const ready = frame.ready.then(() => {
  $("#engineStatus").hidden = true;
  document.body.classList.add("engine-ready");
  return frame;
}, (e) => {
  $("#engineStatus").textContent = tf("The document editor could not start: {m}", { m: e.message });
  $("#engineStatus").classList.add("error");
  throw e;
});
frame.on("dirty", (m) => { S.edDirty = !!m.dirty; if (dirty()) keepCopySoon(); show(); });
frame.on("saveRequest", () => busy(save));
frame.on("warning", (m) => { if (m.warnings && m.warnings.length) toast(t("Some parts of this document could not be kept:") + " " + m.warnings.join(" · "), true); });

/* ---------------------------------------------------------------- open, new, close */
/** Before replacing the open document: true to go on (saved, or the changes given up). */
async function leave() {
  if (!dirty()) return true;
  const v = await ask(t("Save your changes?"), tf("“{name}” has changes that are not saved.", { name: S.name }),
    [[null, t("Cancel")], ["discard", t("Don't save")], ["save", t("Save"), true]]);
  if (v === "save") return await save();
  return v === "discard";
}
async function openDoc(file, handle, o = {}) {
  const k = kindOf(file.name);
  if (!k) {
    if (/\.doc$/i.test(file.name)) return toast(t("Old Word files (.doc) cannot be opened: save them as .docx in Word or LibreOffice first."), true);
    if (/\.pdf$/i.test(file.name)) return toast(t("This is a PDF: open it in the PDF editor."), true);
    return toast(t("Please choose a Word (.docx) or LibreOffice (.odt) document."), true);
  }
  if (!o.skipLeave && !(await leave())) return false;
  const ed = await ready;
  const ok = await ed.load(file, file.name);
  if (!ok) return false;                                    // the reader gave up at a password
  Object.assign(S, { open: true, name: o.name || file.name, fmt: k.fmt, template: k.template, handle: k.template ? null : handle || null,
                     edDirty: false, hostDirty: !!o.dirty, recentId: null, copyHash: "" });
  await ed.configure({ name: base(S.name) });
  await STORE.del("keep", "recovery");
  if (S.handle) S.recentId = await remember(S.handle, S.name);
  if (S.hostDirty) keepCopySoon();
  show();
  if (!o.quiet) stats("doc_opened");
  return true;
}
async function newDoc() {
  if (!(await leave())) return;
  const ed = await ready;
  const name = t("Untitled") + ".docx";
  await ed.newDocument(base(name));
  Object.assign(S, { open: true, name, fmt: "docx", template: false, handle: null, edDirty: false, hostDirty: false, recentId: null, copyHash: "" });
  await STORE.del("keep", "recovery");
  show();
  stats("doc_created");
}
async function closeDoc() {
  if (!(await leave())) return;
  const ed = await ready;
  await ed.newDocument();
  Object.assign(S, { open: false, name: "", handle: null, edDirty: false, hostDirty: false, recentId: null, copyHash: "" });
  await STORE.del("keep", "recovery");
  show();
  renderStart();
}
async function pickAndOpen() {
  if (FS) {
    let h;
    try { [h] = await window.showOpenFilePicker({ types: OPEN_TYPES, excludeAcceptAllOption: false }); }
    catch (e) { return; }                                   // cancelled
    return openDoc(await h.getFile(), h);
  }
  $("#fileInput").click();
}

/* ---------------------------------------------------------------- save, download */
async function writeInto(handle, file) {
  if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted" && (await handle.requestPermission({ mode: "readwrite" })) !== "granted")
    throw Object.assign(new Error(t("Permission to write into the file was not given.")), { name: "NotAllowedError" });
  const w = await handle.createWritable();
  await w.write(file);
  await w.close();
}
function downloadFile(file, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function saved() {
  const ed = await ready;
  await ed.markSaved();
  S.edDirty = false; S.hostDirty = false; S.copyHash = "";
  await STORE.del("keep", "recovery");
  show();
}
/** Save: into the opened file; else a new file (Chrome, Edge); else a download. True once stored. */
async function save() {
  if (!S.open) return false;
  const ed = await ready;
  if (S.handle) {
    try {
      await writeInto(S.handle, await ed.export(S.fmt));
      await saved();
      toast(tf("Saved in “{name}”", { name: S.name }));
      stats("doc_saved");
      return true;
    } catch (e) {
      if (e && e.name === "NotAllowedError") { toast(e.message, true); return false; }
      if (!(e && e.name === "NotFoundError")) throw e;
      S.handle = null;                                      // the file was moved or deleted: save a new one
    }
  }
  if (FS) return saveAs();
  const name = base(S.name) + TYPES[S.fmt].ext;
  downloadFile(await ed.export(S.fmt), name);
  await saved();
  toast(tf("Downloaded “{name}”", { name }));
  stats("doc_downloaded");
  return true;
}
async function saveAs() {
  const ed = await ready;
  const order = S.fmt === "odt" ? ["odt", "docx"] : ["docx", "odt"];
  let h;
  try {
    h = await window.showSaveFilePicker({ suggestedName: base(S.name) + TYPES[order[0]].ext,
      types: order.map((f) => ({ description: t(TYPES[f].label), accept: { [TYPES[f].mime]: [TYPES[f].ext] } })) });
  } catch (e) { return false; }                             // cancelled
  const k = kindOf(h.name) || { fmt: order[0] };
  await writeInto(h, await ed.export(k.fmt));
  Object.assign(S, { handle: h, name: h.name, fmt: k.fmt, template: false });
  await ed.configure({ name: base(S.name) });
  S.recentId = await remember(h, h.name);
  await saved();
  toast(tf("Saved in “{name}”", { name: S.name }));
  stats("doc_saved");
  return true;
}
async function downloadAs(fmt) {
  const ed = await ready;
  const name = base(S.name) + TYPES[fmt].ext;
  downloadFile(await ed.export(fmt), name);
  toast(tf("Downloaded “{name}”", { name }));
  stats("doc_downloaded");
}

/* ---------------------------------------------------------------- the unsaved copy */
let copyTimer = 0, copyBusy = false;
function keepCopySoon(ms = 2500) {
  clearTimeout(copyTimer);
  copyTimer = setTimeout(keepCopy, ms);
}
async function keepCopy() {
  clearTimeout(copyTimer);
  if (!dirty() || copyBusy) return;
  copyBusy = true;
  try {
    const ed = await ready;
    const file = await ed.export(S.fmt);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
    if (dirty() && hash !== S.copyHash) {
      await STORE.put("keep", { id: "recovery", file, name: S.name, handle: S.handle, template: S.template, time: Date.now() });
      S.copyHash = hash;
    }
  } catch (e) { /* storage full or unavailable: no copy */ }
  finally { copyBusy = false; if (dirty()) copyTimer = setTimeout(keepCopy, COPY_EVERY); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty()) keepCopy(); });
let leaving = false;
addEventListener("beforeunload", (e) => { if (dirty() && !leaving) { keepCopy(); e.preventDefault(); e.returnValue = ""; } });

/* ---------------------------------------------------------------- recent files and the start screen */
async function remember(handle, name) {
  if (!FS || !handle) return null;
  try {
    const list = await STORE.all("recent");
    let same = null;
    for (const x of list) { try { if (await x.handle.isSameEntry(handle)) { same = x; break; } } catch (e) {} }
    const id = same ? same.id : crypto.randomUUID();
    await STORE.put("recent", { id, name, handle, time: Date.now() });
    for (const x of list.filter((x) => x.id !== id).sort((a, b) => b.time - a.time).slice(RECENT_KEEP - 1)) await STORE.del("recent", x.id);
    return id;
  } catch (e) { return null; }
}
const when = (ms) => new Date(ms).toLocaleString(document.documentElement.lang || "en", { dateStyle: "short", timeStyle: "short" });
const DOC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>';
async function renderStart() {
  const rec = await STORE.get("keep", "recovery");
  $("#recovery").hidden = !rec;
  if (rec) $("#recoveryText").textContent = tf("in “{name}” · {when}", { name: rec.name, when: when(rec.time) });
  const list = (await STORE.all("recent")).sort((a, b) => b.time - a.time).slice(0, RECENT_SHOW);
  const ul = $("#recentList");
  ul.textContent = "";
  $("#recentFiles").hidden = !list.length;
  for (const x of list) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "rf-open";
    b.innerHTML = DOC_ICON + '<span class="rf-name"></span><span class="rf-when"></span>';
    b.querySelector(".rf-name").textContent = x.name;
    b.querySelector(".rf-when").textContent = when(x.time);
    b.title = tf("Open “{name}”", { name: x.name });
    b.onclick = () => busy(async () => {
      if ((await x.handle.queryPermission({ mode: "read" })) !== "granted" && (await x.handle.requestPermission({ mode: "read" })) !== "granted") return;
      let file;
      try { file = await x.handle.getFile(); }
      catch (e) { await STORE.del("recent", x.id); renderStart(); return toast(t("This file was moved or deleted. It was removed from the list."), true); }
      await openDoc(file, x.handle);
    });
    const del = document.createElement("button");
    del.className = "rf-del";
    del.textContent = "✕";
    del.title = t("Remove from this list");
    del.setAttribute("aria-label", del.title);
    del.onclick = async () => { await STORE.del("recent", x.id); renderStart(); };
    li.append(b, del);
    ul.appendChild(li);
  }
}
$("#btnResume").onclick = () => busy(async () => {
  const rec = await STORE.get("keep", "recovery");
  if (!rec) return renderStart();
  await openDoc(new File([rec.file], rec.name, { type: rec.file.type }), rec.handle, { dirty: true, skipLeave: true, quiet: true, name: rec.name });
});
$("#btnDiscard").onclick = async () => { await STORE.del("keep", "recovery"); renderStart(); };

/* ---------------------------------------------------------------- menus: download, language */
function menu(btn, id, items, cls = "") {
  const m = document.createElement("div");
  m.id = id; m.className = "tools-menu " + cls; m.setAttribute("role", "menu"); m.hidden = true;
  for (const it of items) {
    const b = document.createElement("button");
    b.setAttribute("role", it.checked === undefined ? "menuitem" : "menuitemradio");
    if (it.checked !== undefined) b.setAttribute("aria-checked", it.checked ? "true" : "false");
    b.innerHTML = '<span class="lm-check"></span><span class="lm-name"></span><span class="lm-hint" data-noi18n></span>';
    b.querySelector(".lm-check").textContent = it.checked ? "✓" : "";
    const nm = b.querySelector(".lm-name");
    nm.textContent = it.label;
    b.querySelector(".lm-hint").textContent = it.hint || "";
    if (it.lang) { nm.lang = it.lang; nm.dir = it.dir; }
    b.onclick = () => { close(); it.run(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const close = () => { m.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const open = () => {
    m.hidden = false;
    const r = btn.getBoundingClientRect(), w = m.offsetWidth, rtl = document.documentElement.dir === "rtl";
    const x = rtl ? Math.max(8, r.left) : Math.min(r.left, innerWidth - w - 8);
    Object.assign(m.style, { top: r.bottom + 6 + "px", left: Math.max(8, x) + "px" });
    btn.setAttribute("aria-expanded", "true");
    (m.querySelector('[aria-checked="true"]') || m.querySelector("button")).focus();
  };
  btn.onclick = (e) => { e.stopPropagation(); m.hidden ? open() : close(); };
  document.addEventListener("pointerdown", (e) => { if (!m.hidden && !m.contains(e.target) && !btn.contains(e.target)) close(); }, true);
  m.addEventListener("keydown", (e) => {
    const bs = [...m.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
    if (e.key === "Escape") { close(); btn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
  });
  return m;
}
function buildMenus() {
  menu($("#btnDownload"), "downloadMenu", [
    { label: t("Word document"), hint: ".docx", run: () => busy(() => downloadAs("docx")) },
    { label: t("LibreOffice document"), hint: ".odt", run: () => busy(() => downloadAs("odt")) },
    { label: "PDF", hint: ".pdf", run: () => busy(() => downloadAs("pdf")) },
  ]);
  if (!window.I18N) return;
  const cur = I18N.languages.find((l) => l.code === I18N.lang);
  $("#btnLangName").textContent = cur ? cur.name : "English";
  const bl = I18N.languages.find((l) => l.code === I18N.browser);
  menu($("#btnLang"), "langMenu", [
    { label: `${t("Browser language")} (${bl ? bl.name : "English"})`, checked: I18N.auto, run: () => !I18N.auto && busy(() => changeLanguage("auto")) },
    ...I18N.languages.map((l) => ({ label: l.name, lang: l.code, dir: l.dir, checked: !I18N.auto && l.code === I18N.lang,
                                     run: () => (I18N.auto || l.code !== I18N.lang) && busy(() => changeLanguage(l.code)) })),
  ], "lang-menu");
}
/** The page reloads in the other language; the open document comes back as it was, changes included. */
async function changeLanguage(code) {
  if (S.open) {
    const ed = await ready;
    const file = await ed.export(S.fmt);
    await STORE.put("keep", { id: "reopen", file, name: S.name, handle: S.handle, dirty: dirty(), time: Date.now() });
  }
  leaving = true;
  I18N.set(code);
}

/* ---------------------------------------------------------------- buttons, keys, dropping a file */
$("#btnOpen").onclick = $("#btnOpen2").onclick = () => busy(pickAndOpen);
$("#btnNew").onclick = $("#btnNew2").onclick = () => busy(newDoc);
$("#btnSave").onclick = () => busy(save);
$("#btnClose").onclick = () => busy(closeDoc);
$("#fileInput").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) busy(() => openDoc(f, null)); };
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "s") { e.preventDefault(); busy(e.shiftKey && FS && S.open ? saveAs : save); }
  else if (k === "o") { e.preventDefault(); busy(pickAndOpen); }
});
let drag = 0;
const hasFile = (e) => [...(e.dataTransfer && e.dataTransfer.types) || []].includes("Files");
addEventListener("dragenter", (e) => { if (!hasFile(e)) return; e.preventDefault(); if (drag++ === 0) { document.body.classList.add("dragging-file"); if (S.open) $("#dropOverlay").hidden = false; } });
addEventListener("dragleave", () => { if (--drag <= 0) { drag = 0; document.body.classList.remove("dragging-file"); $("#dropOverlay").hidden = true; } });
addEventListener("dragover", (e) => { if (hasFile(e)) e.preventDefault(); });
addEventListener("drop", (e) => {
  if (!hasFile(e)) return;
  e.preventDefault();
  drag = 0; document.body.classList.remove("dragging-file"); $("#dropOverlay").hidden = true;
  const file = [...e.dataTransfer.files][0];
  if (!file) return;
  const it = [...(e.dataTransfer.items || [])].find((i) => i.kind === "file" && i.getAsFileSystemHandle);
  const hp = it && FS ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
  busy(async () => openDoc(file, await hp));
});

/* ---------------------------------------------------------------- start */
(async () => {
  if (window.I18N) await I18N.ready;
  buildMenus();
  show();
  // back from a language change, or a document sent by the PDF editor
  const again = await STORE.take("keep", "reopen");
  const hand = !again && location.hash === "#open" ? await STORE.take("keep", "handoff") : null;
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (again) await busy(() => openDoc(new File([again.file], again.name, { type: again.file.type }), again.handle, { dirty: again.dirty, skipLeave: true, quiet: true, name: again.name }));
  else if (hand) await busy(() => openDoc(hand.file, hand.handle, { skipLeave: true }));
  if (!S.open) renderStart();
})();

window.WRITE = { S, frame, save, saveAs, openDoc, newDoc, closeDoc, keepCopy };   // tests
