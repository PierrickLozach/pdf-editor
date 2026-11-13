/* PDF Editor - the editor's interface (runs in the browser; the PDF engine runs in worker.js).
 * This file is the source: edit it directly. */
/* PDF Editor - front end (plain JavaScript, no dependencies). */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ZOOMS = [0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const S = {
  doc: null,            // {id, name, pages:[{w,h,rotation,v}], canUndo, canRedo}
  zoom: 1,
  tool: "edit",
  spans: {},            // page token -> spans
  hits: [], cur: -1,
  dirty: false,
  image: null,          // {blob, w, h, name}
  fonts: null,
  addDefaults: { fontKey: "b:liberationsans", size: 12, color: "#000000", bold: false, italic: false },
  localFonts: null,     // postscriptName -> FontData (Local Font Access API)
  ed: null,             // active inline editor
  current: 0,
};

/* ---------------------------------------------------------------- helpers */
/* The PDF engine runs in a Web Worker (MuPDF compiled to WebAssembly): files never leave this device. */
let engineWorker = null, callSeq = 0;
const calls = new Map();
let engineReady = null;
function startEngine() {
  engineReady = new Promise((resolve, reject) => {
    try { engineWorker = new Worker("worker.js?v=742cd1cafc", { type: "module" }); }
    catch (e) { reject(new Error("This browser cannot run the editor (no module workers). Please update it.")); return; }
    const failed = (msg) => reject(new Error("The PDF engine failed to start" + (msg ? ": " + msg : "") + ". Reload the page, or try an up-to-date Chrome, Edge, Firefox or Safari."));
    const timer = setTimeout(() => failed("it took too long"), 60000);
    engineWorker.onerror = (e) => { e.preventDefault(); clearTimeout(timer); failed(e.message); };
    engineWorker.onmessage = async (ev) => {
      const m = ev.data;
      if (m.hello) { clearTimeout(timer); call("fontList").then((f) => { S.fonts = f; resolve(); }, reject); return; }
      if (m.fatal) { clearTimeout(timer); console.error(m.fatal); if (!S.fonts) failed(m.fatal); else toast(m.fatal, true); return; }
      if (m.req) return answerWorker(m);
      const c = calls.get(m.id);
      if (!c) return;
      calls.delete(m.id);
      m.ok ? c.resolve(m.result) : c.reject(new Error(m.error));
    };
  });
  return engineReady;
}
function call(op, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++callSeq;
    calls.set(id, { resolve, reject });
    const transfer = args.filter((a) => a instanceof Uint8Array).map((a) => a.buffer);
    engineWorker.postMessage({ id, op, args }, transfer);
  });
}
async function answerWorker(m) {
  try {
    if (m.type !== "localFont") throw new Error("unknown request");
    const f = S.localFonts && S.localFonts.get(m.postscriptName);
    if (!f) throw new Error("font not available");
    const buf = await (await f.blob()).arrayBuffer();
    engineWorker.postMessage({ req: m.req, bytes: buf }, [buf]);
  } catch (e) { engineWorker.postMessage({ req: m.req, error: e.message }); }
}
const PLAIN = (() => { const d = document.createElement("div"); d.contentEditable = "plaintext-only"; return d.contentEditable === "plaintext-only"; })();
function outName(name) { return String(name || "document").replace(/\.pdf$/i, "").replace(/[\/\\:]/g, "-") + ".pdf"; }   // the same name: nothing tells it was edited
function triggerDownload(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function busy(fn) {
  document.body.classList.add("busy");
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { document.body.classList.remove("busy"); }
}

let toastTimer;
function toast(msg, error = false, ms) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", !!error);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms || (error ? 6000 : 3500));
}

function modal({ title, text, input = false, ok = "OK", danger = false }) {
  return new Promise(res => {
    const m = $("#modal"), inp = $("#modalInput"), okb = $("#modalOk");
    $("#modalTitle").textContent = title;
    $("#modalText").textContent = text || "";
    inp.hidden = !input; inp.value = "";
    okb.textContent = ok;
    okb.classList.toggle("primary", true);
    m.hidden = false;
    (input ? inp : okb).focus();
    const done = v => { m.hidden = true; okb.onclick = $("#modalCancel").onclick = inp.onkeydown = null; res(v); };
    okb.onclick = () => done(input ? inp.value : true);
    $("#modalCancel").onclick = () => done(null);
    inp.onkeydown = e => { if (e.key === "Enter") done(inp.value); if (e.key === "Escape") done(null); };
    m.onkeydown = e => { if (e.key === "Escape") done(null); };
  });
}

const faces = {};
function loadFace(fontId) {
  if (!faces[fontId]) {
    const name = "pdfe" + Object.keys(faces).length;
    faces[fontId] = call("fontBytes", fontId).then(async (bytes) => {
      if (!bytes) return null;
      const f = await new FontFace(name, bytes).load();
      document.fonts.add(f);
      return name;
    }).catch(() => null);
  }
  return faces[fontId];
}

function renderScale() {
  return Math.min(4, Math.ceil(S.zoom * (window.devicePixelRatio || 1) * 4) / 4);
}


/* ---------------------------------------------------------------- open / save */
async function openFile(file, password) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return toast("Please choose a PDF file", true);
  if (window.FILES && !password && !(await FILES.check(file))) return;
  closeEditor(false);
  if (S.dirty && S.doc && !(await modal({ title: "Open another PDF?", text: `Your edits to “${S.doc.name}” have not been saved. They will be lost.`, ok: "Open anyway" }))) return;
  document.body.classList.add("busy");
  try {
    await engineReady;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await call("open", bytes, file.name, password);
    window.PDFE_STATS && PDFE_STATS.event("pdf_opened", { size: bytes.length || bytes.byteLength });
    $("#resume").hidden = true;
    loadDoc(info, true);
    if (window.FILES) FILES.opened(file);
    if (window.ACTIVE) ACTIVE.check();
  } catch (e) {
    if (e.message === "PASSWORD_REQUIRED" || e.message === "WRONG_PASSWORD") {
      document.body.classList.remove("busy");
      const pw = await modal({ title: "Password-protected PDF",
        text: e.message === "WRONG_PASSWORD" ? "Wrong password, try again:" : `“${file.name}” needs a password to open:`, input: true, ok: "Open" });
      if (pw) return openFile(file, pw);
    } else toast(e.message, true);
  } finally { document.body.classList.remove("busy"); }
}

function loadDoc(info, fresh) {
  if (window.PROTOOLS) PROTOOLS.docChanged();
  S.doc = info;
  S.spans = {};
  S.hits = []; S.cur = -1;
  S.dirty = false;
  document.body.classList.add("has-doc");
  $("#docName").textContent = info.name;
  $("#docName").title = info.name;
  document.title = info.name + " – PDF Editor";
  if (fresh) S.zoom = fitZoom(1.6);
  buildPages();
  buildThumbs();
  updateButtons();
  $("#viewer").scrollTop = 0;
  if (!$("#findPanel").hidden && $("#findInput").value) runFind();

}

async function saveFile() {
  if (!S.doc) return;
  if (window.ACTIVE) await ACTIVE.remove(false);                         // never pass on scripts, launch actions...
  if (window.FILES && await FILES.save()) return;                          // saved into the file that was opened
  await closeEditor(true);
  await busy(async () => {
    const bytes = await call("export");
    const name = outName(S.doc.name);
    if (window.showSaveFilePicker) {            // Chrome / Edge: real "Save as" dialog
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }] });
        const w = await h.createWritable();
        await w.write(bytes);
        await w.close();
        S.dirty = false;
        call("markSaved").catch(() => {});
        if (window.FILES) FILES.adopt(h);
        toast(`Saved: ${h.name}`);
        window.PDFE_STATS && PDFE_STATS.event("pdf_saved");
        return;
      } catch (e) { if (e.name === "AbortError") return; }
    }
    triggerDownload(bytes, name);
    S.dirty = false;
    call("markSaved").catch(() => {});
    toast(`Downloaded: ${name}`);
    window.PDFE_STATS && PDFE_STATS.event("pdf_downloaded");
  });
}

async function download() {
  if (!S.doc) return;
  if (window.ACTIVE) await ACTIVE.remove(false);
  closeEditor(true).then(() => busy(async () => {
    const bytes = await call("export");
    triggerDownload(bytes, outName(S.doc.name));
    window.PDFE_STATS && PDFE_STATS.event("pdf_downloaded");
    S.dirty = false;
    call("markSaved").catch(() => {});
  }));
}

function updateButtons() {
  const has = !!S.doc;
  $$(".needs-doc").forEach(b => (b.disabled = !has));
  $("#btnUndo").disabled = !has || !S.doc.canUndo;
  $("#btnRedo").disabled = !has || !S.doc.canRedo;
  $("#btnZoomLabel").textContent = Math.round(S.zoom * 100) + "%";
}

/* Apply the document state the server returned after an operation. */
function applyInfo(info) {
  const old = S.doc;
  S.doc = info;
  S.dirty = true;
  if (window.FILES) FILES.afterChange();
  const sameLayout = old && old.pages.length === info.pages.length &&
    old.pages.every((p, i) => p.w === info.pages[i].w && p.h === info.pages[i].h);
  if (!sameLayout) {
    const st = $("#viewer").scrollTop;
    buildPages();
    buildThumbs();
    $("#viewer").scrollTop = st;
  } else {
    info.pages.forEach((p, i) => {
      if (old.pages[i].v !== p.v) { refreshPage(i); refreshThumb(i); }
    });
  }
  updateButtons();
}

/* ---------------------------------------------------------------- pages */
let pageObserver, thumbObserver;

function fitZoom(max = 4) {
  const v = $("#viewer");
  const avail = v.clientWidth - 56;
  const w = Math.max(...S.doc.pages.map(p => p.w));
  return Math.max(0.33, Math.min(max, avail / w));
}

function buildPages() {
  const box = $("#pages");
  box.innerHTML = "";
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      const i = +e.target.dataset.i;
      e.target._visible = e.isIntersecting;
      clearTimeout(e.target._freeT);
      if (e.isIntersecting) loadPage(i);
      else e.target._freeT = setTimeout(() => freePage(e.target), 5000);
    }
  }, { root: $("#viewer"), rootMargin: "900px 0px" });
  S.doc.pages.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.i = i;
    el.style.width = p.w * S.zoom + "px";
    el.style.height = p.h * S.zoom + "px";
    el.innerHTML = `<div class="loading">Loading…</div><canvas class="render" width="0" height="0"></canvas>
      <div class="layer"><div class="spans"></div><div class="hits"></div></div><div class="pnum">${i + 1} / ${S.doc.pages.length}</div>`;
    bindLayer(el, i);
    box.appendChild(el);
    pageObserver.observe(el);
  });
  for (let i = 0; i < Math.min(2, S.doc.pages.length); i++) { pageEl(i)._visible = true; loadPage(i); }
  drawHits();
}

function pageEl(i) { return $(`#pages .page[data-i="${i}"]`); }

function loadPage(i) {
  const el = pageEl(i);
  if (!el || !S.doc.pages[i]) return;
  const p = S.doc.pages[i];
  const key = p.v + "@" + renderScale();
  if (el.dataset.rkey !== key) { el.dataset.want = key; requestRender(i); }
  if (S.tool === "edit") loadSpans(i);
}

/* At most two renders in flight, visible pages first: fast scrolling never queues a backlog. */
const renderQ = new Set();
let renderBusy = 0;
function requestRender(i) { renderQ.add(i); pumpRender(); }
function pumpRender() {
  while (renderBusy < 2 && renderQ.size) {
    const i = [...renderQ].sort((a, b) => Math.abs(a - S.current) - Math.abs(b - S.current))[0];
    renderQ.delete(i);
    const el = pageEl(i);
    if (!el || !el._visible || !S.doc.pages[i]) continue;
    const key = el.dataset.want, scale = renderScale();
    if (!key || el.dataset.rkey === key) continue;
    renderBusy++;
    call("render", i, scale).then((r) => {
      const cur = pageEl(i);
      if (!cur || !S.doc.pages[i] || r.v !== S.doc.pages[i].v || cur.dataset.want !== key) return;
      const c = $("canvas.render", cur);
      c.width = r.w; c.height = r.h;
      c.getContext("2d").putImageData(new ImageData(r.pixels, r.w, r.h), 0, 0);
      cur.dataset.rkey = key;
      const l = $(".loading", cur); if (l) l.remove();
      cur.dispatchEvent(new Event("rendered"));
    }).catch((e) => console.warn(e)).finally(() => { renderBusy--; pumpRender(); });
  }
}
function freePage(el) {
  if (el._visible) return;
  const c = $("canvas.render", el);
  if (c && c.width) { c.width = c.height = 0; el.dataset.rkey = ""; }
}

function refreshPage(i) {
  const el = pageEl(i);
  if (!el) return;
  if (window.REMOVE && REMOVE.sel && REMOVE.sel.page === i) REMOVE.clear();
  if (window.REDACT && REDACT.on) setTimeout(() => REDACT.redraw(), 0);
  $(".spans", el).innerHTML = "";
  el.dataset.spansV = "";
  const nt = $(".notext", el); if (nt) nt.remove();
  if (el._visible) loadPage(i);
}

function setZoom(z, anchorY) {
  if (!S.doc) return;
  closeEditor(true);
  const v = $("#viewer");
  const ratio = (v.scrollTop + (anchorY ?? v.clientHeight / 2)) / Math.max(1, v.scrollHeight);
  S.zoom = Math.max(0.25, Math.min(4, z));
  S.doc.pages.forEach((p, i) => {
    const el = pageEl(i);
    el.style.width = p.w * S.zoom + "px";
    el.style.height = p.h * S.zoom + "px";
    $(".spans", el).innerHTML = "";
    el.dataset.spansV = "";
  });
  v.scrollTop = ratio * v.scrollHeight - (anchorY ?? v.clientHeight / 2);
  clearTimeout(setZoom.t);
  setZoom.t = setTimeout(() => $$("#pages .page").forEach(el => el._visible && loadPage(+el.dataset.i)), 120);
  drawHits();
  updateButtons();
  if (window.PLACE) PLACE.redraw();
  if (window.REDACT && REDACT.on) REDACT.redraw();
  if (window.REMOVE) REMOVE.clear();
}

function zoomStep(dir) {
  const i = ZOOMS.findIndex(z => z >= S.zoom - 0.001);
  let n;
  if (dir > 0) n = ZOOMS.find(z => z > S.zoom + 0.001) ?? 4;
  else n = [...ZOOMS].reverse().find(z => z < S.zoom - 0.001) ?? ZOOMS[0];
  setZoom(n);
}

/* ---------------------------------------------------------------- editable text */
async function loadSpans(i) {
  const el = pageEl(i);
  const p = S.doc.pages[i];
  const key = p.v + "@" + S.zoom;
  if (el.dataset.spansV === key) return;
  el.dataset.spansV = key;
  let spans = S.spans[p.v];
  if (!spans) {
    try { spans = await call("pageText", i); }
    catch (e) { el.dataset.spansV = ""; return; }
    S.spans[p.v] = spans;
  }
  if (S.doc.pages[i].v !== p.v) return;   // page changed meanwhile
  const layer = $(".spans", el);
  layer.innerHTML = "";
  const z = S.zoom;
  for (const sp of spans) {
    const d = document.createElement("div");
    d.className = "span" + (sp.editable ? "" : " locked");
    const [x0, y0, x1, y1] = sp.bbox;
    Object.assign(d.style, { left: x0 * z + "px", top: y0 * z + "px", width: (x1 - x0) * z + "px", height: (y1 - y0) * z + "px" });
    d.title = sp.editable ? "Click to edit · drag to move" : "Click to select it (to delete it)";
    d.addEventListener("pointerdown", async e => {
      if (S.tool !== "edit" || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (!sp.editable) { if (window.REMOVE) REMOVE.selectText(i, sp); return; }   // a stamp, a watermark: select it, to delete it
      const v0 = p.v;
      if (S.pending) await S.pending;
      let target = sp;
      if (S.doc.pages[i].v !== v0) {      // the page was just edited: find the same text again
        let fresh = S.spans[S.doc.pages[i].v];
        if (!fresh) {
          fresh = await call("pageText", i);
          S.spans[S.doc.pages[i].v] = fresh;
        }
        const cx = (sp.bbox[0] + sp.bbox[2]) / 2, cy = (sp.bbox[1] + sp.bbox[3]) / 2;
        target = fresh.find(f => f.text === sp.text && Math.abs((f.bbox[0] + f.bbox[2]) / 2 - cx) < 2 && Math.abs((f.bbox[1] + f.bbox[3]) / 2 - cy) < 2)
          || fresh.find(f => f.bbox[0] <= cx && cx <= f.bbox[2] && f.bbox[1] <= cy && cy <= f.bbox[3]);
        if (!target) return;
      }
      startEdit(i, target);
    });
    layer.appendChild(d);
  }
  if (window.REMOVE) REMOVE.decorate(i, el, layer);           // clickable pictures, under the text
  if (window.PROTOOLS) PROTOOLS.decorate(i, el, layer);       // form fields, comparison highlights
  const old = $(".notext", el); if (old) old.remove();
  if (!spans.length) {
    const n = document.createElement("div");
    n.className = "notext";
    n.textContent = "No editable text on this page (scanned image?) – use Whiteout + Add text.";
    el.appendChild(n);
  }
  if (typeof mvAfterSpans === "function") mvAfterSpans(i);
}

/* ---------------------------------------------------------------- thumbnails */
function buildThumbs() {
  const box = $("#thumbs");
  box.innerHTML = "";
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) refreshThumb(+e.target.dataset.i, true);
  }, { root: box, rootMargin: "400px 0px" });
  S.doc.pages.forEach((p, i) => {
    const t = document.createElement("div");
    t.className = "thumb";
    t.dataset.i = i;
    t.draggable = true;
    const h = Math.round(120 * p.h / p.w);
    t.innerHTML = `<div class="tframe"><canvas width="0" height="0" aria-label="Page ${i + 1}"></canvas></div>
      <div class="num">${i + 1}</div>
      <div class="tacts">
        <button data-act="rotate" title="Rotate 90° clockwise"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 1-2.3-5.7L20 8"/><path d="M20 3v5h-5"/></svg></button>
        <button data-act="duplicate" title="Duplicate page"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button>
        <button data-act="blank" title="Insert a blank page after"><svg viewBox="0 0 24 24"><path d="M12 8v8M8 12h8"/><rect x="4" y="3" width="16" height="18" rx="2"/></svg></button>
        <button data-act="delete" class="danger" title="Delete page"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
      </div>`;
    t.addEventListener("click", e => {
      const b = e.target.closest("button[data-act]");
      if (b) { e.stopPropagation(); pageAction(b.dataset.act, +t.dataset.i); return; }
      scrollToPage(+t.dataset.i);
    });
    t.querySelector(".tframe").style.height = h + "px";     // set from code: no inline style in HTML (CSP)
    bindThumbDrag(t);
    box.appendChild(t);
    thumbObserver.observe(t);
  });
  markCurrent();
}

function refreshThumb(i, lazy) {
  const t = $(`#thumbs .thumb[data-i="${i}"]`);
  if (!t || !S.doc.pages[i]) return;
  const c = $("canvas", t);
  const v = S.doc.pages[i].v;
  if (lazy && c.dataset.v === v) return;
  if (!lazy && !c.dataset.v) return;       // not loaded yet: the observer will do it
  c.dataset.v = v;
  call("render", i, Math.min(1, 240 / S.doc.pages[i].w)).then((r) => {
    if (c.dataset.v !== r.v) return;
    c.width = r.w; c.height = r.h;
    c.getContext("2d").putImageData(new ImageData(r.pixels, r.w, r.h), 0, 0);
  }).catch(() => {});
}

function scrollToPage(i, offset = 0) {
  const el = pageEl(i);
  if (el) $("#viewer").scrollTo({ top: el.offsetTop - 16 + offset, behavior: "smooth" });
}

function markCurrent() {
  const v = $("#viewer");
  const mid = v.scrollTop + v.clientHeight / 3;
  let cur = 0;
  for (const el of $$("#pages .page")) { if (el.offsetTop <= mid) cur = +el.dataset.i; else break; }
  S.current = cur;
  $$("#thumbs .thumb").forEach(t => t.classList.toggle("current", +t.dataset.i === cur));
  const ct = $(`#thumbs .thumb[data-i="${cur}"]`);
  if (ct) {
    const box = $("#thumbs");
    if (ct.offsetTop < box.scrollTop || ct.offsetTop + ct.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = ct.offsetTop - 20;
  }
}

async function pageAction(act, i) {
  closeEditor(true);
  if (act === "delete") {
    const ok = await modal({ title: `Delete page ${i + 1}?`, text: "You can undo this with ⌘Z.", ok: "Delete" });
    if (!ok) return;
  }
  await busy(async () => {
    const info = await call("pageOp", act, i, 90);
    applyInfo(info);
    if (act === "rotate") scrollToPage(i);
  });
}

let dragFrom = null;
function bindThumbDrag(t) {
  t.addEventListener("dragstart", e => { dragFrom = +t.dataset.i; t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "page"); });
  t.addEventListener("dragend", () => { t.classList.remove("dragging"); $$(".thumb").forEach(x => x.classList.remove("drag-over-before", "drag-over-after")); dragFrom = null; });
  t.addEventListener("dragover", e => {
    if (dragFrom === null) return;
    e.preventDefault();
    const r = t.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    $$(".thumb").forEach(x => x.classList.remove("drag-over-before", "drag-over-after"));
    t.classList.add(before ? "drag-over-before" : "drag-over-after");
  });
  t.addEventListener("drop", async e => {
    if (dragFrom === null) return;
    e.preventDefault(); e.stopPropagation();
    const r = t.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const target = +t.dataset.i;
    let to = before ? target : target + 1;
    if (dragFrom < to) to -= 1;
    const from = dragFrom;
    if (to === from) return;
    await busy(async () => applyInfo(await call("pageOp", "move", from, 90, to)));
  });
}

/* ---------------------------------------------------------------- inline editor */
function fontOptions(sel, original) {
  sel.innerHTML = "";
  if (original) {
    const o = new Option(`Original – ${original}`, "");
    sel.add(o);
  }
  const g1 = document.createElement("optgroup"); g1.label = "Included fonts";
  S.fonts.bundled.forEach(f => g1.appendChild(new Option(f.label, f.key)));
  sel.add(g1);
  if (S.fonts.local.length) {
    const g2 = document.createElement("optgroup"); g2.label = "Fonts on this computer";
    S.fonts.local.forEach(f => g2.appendChild(new Option(f.label, f.key)));
    sel.add(g2);
  }
  sel.add(new Option("＋ Fonts from this computer…", "__fonts"));
}

function lineBox(size, asc, desc) {
  // Distance from the top of a CSS line box (line-height 1.2) to the baseline, in pt.
  const content = asc - desc;
  return size * ((1.2 - content) / 2 + asc);
}

async function startEdit(pi, sp) {
  closeEditor(true);
  await ensureFonts();
  const el = pageEl(pi);
  const z = S.zoom;
  const box = document.createElement("div");
  box.className = "editbox";
  box.contentEditable = PLAIN ? "plaintext-only" : "true";
  box.spellcheck = false;
  const text = sp.text.replace(/^\s+|\s+$/g, "");
  box.textContent = text;
  const [x0, y0, x1, y1] = sp.bbox;
  const horizontal = Math.abs(sp.displayDir[0] - 1) < 0.01;
  const ox = horizontal ? sp.origin[0] : x0, oy = horizontal ? sp.origin[1] : y0 + sp.size;
  const top = oy - lineBox(sp.size, sp.asc || 0.9, sp.desc || -0.2);
  Object.assign(box.style, {
    top: top * z + "px",
    minWidth: Math.max(8, ((sp.tbox || sp.bbox)[2] - ox) * z + 2) + "px",
    fontSize: sp.size * z + "px", color: sp.color,
  });
  $(".layer", el).appendChild(box);
  S.ed = { mode: "edit", page: pi, span: sp, box, original: text, ox, horizontal, dx: 0, dy: 0,
           style: { fontKey: "", size: sp.size, color: sp.color, bold: sp.bold, italic: sp.italic, fit: false,
                    align: horizontal ? (sp.align || "left") : "left" } };
  placeBox();
  if (typeof edAttach === "function") edAttach();
  fontOptions($("#edFont"), sp.family);
  syncBar();
  focusEnd(box);
  await previewFont();
}

async function startAdd(pi, x, y) {
  closeEditor(true);
  await ensureFonts();
  const el = pageEl(pi);
  const z = S.zoom;
  const d = S.addDefaults;
  const box = document.createElement("div");
  box.className = "editbox add";
  box.contentEditable = PLAIN ? "plaintext-only" : "true";
  box.spellcheck = false;
  Object.assign(box.style, { left: x * z + "px", top: y * z + "px", fontSize: d.size * z + "px", color: d.color, background: "transparent" });
  $(".layer", el).appendChild(box);
  S.ed = { mode: "add", page: pi, box, x, y, original: "", style: { ...d, fit: false } };
  fontOptions($("#edFont"), null);
  syncBar();
  box.focus();
  await previewFont();
}

function placeBox() {
  const ed = S.ed;
  if (!ed || ed.mode !== "edit") return;
  const z = S.zoom, box = ed.box, sp = ed.span, tb = sp.tbox || sp.bbox;
  const pw = S.doc.pages[ed.page].w;
  box.style.left = box.style.right = box.style.transform = "";
  box.style.textAlign = ed.style.align;
  if (ed.style.align === "right") box.style.right = (pw - tb[2]) * z - 1 + "px";
  else if (ed.style.align === "center") { box.style.left = (tb[0] + tb[2]) / 2 * z + "px"; box.style.transform = "translateX(-50%)"; }
  else box.style.left = ed.ox * z - 1 + "px";
  box.style.minWidth = Math.max(8, (tb[2] - (ed.style.align === "left" ? ed.ox : tb[0])) * z + 2) + "px";
  placeBar();
}

function focusEnd(box) {
  box.focus();
  const r = document.createRange();
  r.selectNodeContents(box);
  r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

function syncBar() {
  const ed = S.ed, st = ed.style;
  $("#edFont").value = st.fontKey ?? "";
  if ($("#edFont").selectedIndex < 0) $("#edFont").value = "b:liberationsans";
  $("#edSize").value = +(+st.size).toFixed(2);
  $("#edColor").value = st.color;
  $("#edBold").classList.toggle("on", !!st.bold);
  $("#edItalic").classList.toggle("on", !!st.italic);
  $("#edFit").checked = !!st.fit;
  $("#edFitWrap").hidden = ed.mode !== "edit";
  $("#edAlignWrap").hidden = ed.mode !== "edit" || !ed.horizontal;
  $$("#edAlignWrap button").forEach(b => b.classList.toggle("on", b.dataset.align === st.align));
  const info = $("#edInfo");
  if (ed.mode === "edit") {
    const sp = ed.span;
    const orig = esc(sp.family || sp.font);
    const same = ["exact", "embedded", "free"].includes(sp.fontKind);
    let h = same ? `<span class="ok">✓</span> ${orig} · ${sp.size} pt`
      : sp.fontKind === "compatible" ? `${orig} · ${sp.size} pt <span class="muted">(look-alike font)</span>`
      : `<span class="warn">${orig} not available</span> · ${sp.size} pt`;
    if (!same) h += localFontsPossible() ? ` · <button class="link" id="edUseLocal">Use my fonts</button>` : ` · <button class="link" id="edAddFont">Add font…</button>`;
    if (sp.garbled) h += ` · <span class="warn">this PDF hides its real characters; check the text before applying</span>`;
    info.innerHTML = h + ` <span class="keys">↵ apply · ⇧↵ new line · Esc cancel</span>`;
    const ul = $("#edUseLocal");
    if (ul) ul.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); useLocalFonts(true); };
    const af = $("#edAddFont");
    if (af) af.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); openFontsDialog(); };
  } else {
    info.innerHTML = `<span class="keys">↵ apply · ⇧↵ new line · Esc cancel</span>`;
  }
  $("#editorBar").hidden = false;
  placeBar();
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function placeBar() {
  if (!S.ed) return;
  const bar = $("#editorBar");
  const r = S.ed.box.getBoundingClientRect();
  const bh = bar.offsetHeight, bw = bar.offsetWidth;
  const vr = $("#viewer").getBoundingClientRect();
  let top = r.top - bh - 8;
  if (top < vr.top + 4) top = r.bottom + 8;
  let left = Math.min(Math.max(vr.left + 8, r.left), window.innerWidth - bw - 8);
  bar.style.top = top + "px";
  bar.style.left = left + "px";
  bar.style.visibility = (r.bottom < vr.top || r.top > vr.bottom) ? "hidden" : "visible";
  if (typeof edPlaceGrip === "function") edPlaceGrip();
}

async function previewFont() {
  const ed = S.ed;
  if (!ed) return;
  const st = ed.style, box = ed.box, sp = ed.span;
  let id;
  try {
    if (ed.mode === "edit" && !st.fontKey) {
      id = st.bold === sp.bold && st.italic === sp.italic ? sp.previewId : await call("previewForSpan", sp, st.bold, st.italic);
    } else {
      id = await call("previewFor", st.fontKey || "b:liberationsans", st.bold, st.italic);
    }
  } catch (e) { id = null; }
  const generic = sp && sp.serif ? "serif" : sp && sp.mono ? "monospace" : "sans-serif";
  const name = id ? await loadFace(id) : null;
  if (S.ed !== ed) return;
  box.style.fontFamily = name ? `"${name}", ${generic}` : generic;
  box.style.fontWeight = name ? "normal" : (st.bold ? "bold" : "normal");
  box.style.fontStyle = name ? "normal" : (st.italic ? "italic" : "normal");
  box.style.fontSize = st.size * S.zoom + "px";
  box.style.color = st.color;
  placeBar();
}

function readBox(box) {
  return box.innerText.replace(/\u00a0/g, " ").replace(/\n$/, "");
}

async function closeEditor(commit) {
  if (!S.ed) return S.pending;
  const p = closeEditorNow(commit);
  S.pending = p.finally(() => { if (S.pending === q) S.pending = null; });
  const q = S.pending;
  return p;
}

async function closeEditorNow(commit) {
  const ed = S.ed;
  if (!ed) return;
  S.ed = null;
  $("#editorBar").hidden = true;
  const text = readBox(ed.box);
  const st = ed.style;
  if (!commit) { ed.box.remove(); return; }
  if (ed.mode === "add") {
    if (!text.trim()) { ed.box.remove(); return; }
    S.addDefaults = { fontKey: st.fontKey || "b:liberationsans", size: +st.size, color: st.color, bold: st.bold, italic: st.italic };
    const base = ed.y + lineBox(+st.size, 0.905, -0.212) / 1;
    await busy(async () => {
      window.PDFE_STATS && PDFE_STATS.event("tool_used", { tool: "add" });
      const info = await call("addText", ed.page, ed.x + 1 / S.zoom, base, text,
        { fontKey: st.fontKey || "b:liberationsans", size: +st.size, color: st.color, bold: st.bold, italic: st.italic });
      applyInfo(info);
    });
    ed.box.remove();
    return;
  }
  const sp = ed.span;
  const body = { page: ed.page, span: sp.id, expected: sp.text, text, fit: st.fit, align: st.align };
  let styled = st.align !== (ed.horizontal ? (sp.align || "left") : "left");
  if (st.fontKey) { body.fontKey = st.fontKey; styled = true; }
  if (Math.abs(+st.size - sp.size) > 0.01) { body.size = +st.size; styled = true; }
  if (st.color.toLowerCase() !== sp.color.toLowerCase()) { body.color = st.color; styled = true; }
  if (st.bold !== sp.bold) { body.bold = st.bold; styled = true; }
  if (st.italic !== sp.italic) { body.italic = st.italic; styled = true; }
  const moved = Math.abs(ed.dx || 0) > 0.05 || Math.abs(ed.dy || 0) > 0.05;
  if (text === ed.original && !styled && !moved) { ed.box.remove(); return; }
  if (moved) { body.dx = ed.dx; body.dy = ed.dy; }
  const moveOnly = moved && text === ed.original && !styled;
  ed.box.contentEditable = "false";
  await busy(async () => {
    const info = moveOnly ? await call("moveSpans", body.page, [{ id: sp.id, expected: sp.text }], ed.dx, ed.dy)
                          : await call("editSpan", body.page, body.span, body.expected, body.text, body);
      window.PDFE_STATS && PDFE_STATS.event("text_edited");
    applyInfo(info);
    // letters drawn with a look-alike font: explain once why the computer's fonts help, then redo it with them
    if (!moveOnly && /Liberation|Carlito|Caladea|DejaVu/.test(info.font || "") && !st.fontKey)
      setTimeout(() => maybeFontIntro(sp.family, async () => { applyInfo(await call("undo")); applyInfo(await call("editSpan", body.page, body.span, body.expected, body.text, body)); }), 400);
    if (st.fit && info.size && info.size < sp.size) toast(`Text shrunk to ${info.size} pt to fit`);
  });
  // keep the box until the new render has arrived, so the page doesn't flash
  const pel = pageEl(ed.page);
  if (pel) pel.addEventListener("rendered", () => ed.box.remove(), { once: true });
  else ed.box.remove();
  setTimeout(() => ed.box.remove(), 3000);
}

async function ensureFonts() {
  await engineReady;
}

function bindEditorBar() {
  const upd = async (k, v) => { if (!S.ed) return; S.ed.style[k] = v; await previewFont(); };
  $("#edFont").addEventListener("change", e => {
    if (e.target.value === "__fonts") { e.target.value = S.ed ? (S.ed.style.fontKey ?? "") : ""; openFontsDialog(); return; }
    upd("fontKey", e.target.value);
  });
  $("#edSize").addEventListener("input", e => { const v = parseFloat(e.target.value); if (v > 0) upd("size", v); });
  $("#edColor").addEventListener("input", e => upd("color", e.target.value));
  $("#edBold").addEventListener("click", () => { if (!S.ed) return; upd("bold", !S.ed.style.bold); $("#edBold").classList.toggle("on", S.ed.style.bold); });
  $("#edItalic").addEventListener("click", () => { if (!S.ed) return; upd("italic", !S.ed.style.italic); $("#edItalic").classList.toggle("on", S.ed.style.italic); });
  $("#edFit").addEventListener("change", e => { if (S.ed) S.ed.style.fit = e.target.checked; });
  $$("#edAlignWrap button").forEach(b => b.addEventListener("click", () => {
    if (!S.ed) return;
    S.ed.style.align = b.dataset.align;
    $$("#edAlignWrap button").forEach(x => x.classList.toggle("on", x === b));
    placeBox();
    S.ed.box.focus();
  }));
  $("#edApply").addEventListener("click", () => closeEditor(true));
  $("#edCancel").addEventListener("click", () => closeEditor(false));
  $("#edDelete").addEventListener("click", () => window.REMOVE && REMOVE.deleteEditing());
  $("#editorBar").addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); closeEditor(true); }
  });
  document.addEventListener("keydown", e => {
    if (!S.ed || e.target !== S.ed.box) return;
    // ⌘Z / Ctrl+Z while editing: the browser undoes the typing; once nothing is typed (the text is
    // back to what it was), it closes the box and undoes the previous change of the document
    const mod = e.metaKey || e.ctrlKey, z = keyOf(e);
    if (mod && (z === "z" || z === "y") && readBox(S.ed.box) === (S.ed.original || "") && !S.ed.dx && !S.ed.dy) {
      e.preventDefault();
      closeEditor(false);
      undoRedo(z === "y" || e.shiftKey ? "redo" : "undo");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
    else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
  });
  document.addEventListener("paste", e => {
    if (!S.ed || e.target !== S.ed.box) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\r/g, ""));
  });
  // a click elsewhere applies the change (like Acrobat)
  document.addEventListener("pointerdown", e => {
    if (!S.ed) return;
    if (S.ed.box.contains(e.target) || $("#editorBar").contains(e.target) || !$("#modal").hidden || e.target.closest(".dlg, .edgrip")) return;
    closeEditor(true);
  }, true);
}

/* ---------------------------------------------------------------- tools on the page */
function setTool(t) {
  if (!S.doc) return;
  closeEditor(true);
  if (window.REMOVE) REMOVE.clear();
  if (window.PLACE && PLACE.active && t !== "image") PLACE.cancel(true);
  if (t === "image") {
    if (!S.image) { $("#imageInput").click(); return; }   // the tool is set once a picture is chosen
  }
  S.tool = t;
  document.body.className = document.body.className.replace(/\btool-\w+/g, "").trim() + " tool-" + t;
  $$(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  if (t === "edit") $$("#pages .page").forEach(el => el._visible && loadSpans(+el.dataset.i));
  document.body.dispatchEvent(new Event("toolchange"));
  if (t === "image" && S.image) toast(`Click where “${S.image.name}” should go (or drag to draw its size), then adjust it`);
  if (t === "erase") toast("Drag over the area to white out – text under it is really removed");
  if (t === "add") toast("Click where the new text should start");
}

function ptFromEvent(el, e) {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}

function bindLayer(el, i) {
  const layer = $(".layer", el);
  layer.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".editbox")) return;
    if (S.tool === "add") {
      e.preventDefault();
      const p = ptFromEvent(el, e);
      setTimeout(() => startAdd(i, p.x, p.y), 0);
      return;
    }
    if (S.tool !== "erase" && S.tool !== "image" && S.tool !== "redact") return;
    if (S.tool === "image" && window.PLACE && PLACE.active) return;     // the open frame decides (add or cancel)
    e.preventDefault();
    const a = ptFromEvent(el, e);
    const rb = document.createElement("div");
    rb.className = "rubber" + (S.tool === "erase" ? " erase" : S.tool === "redact" ? " redact" : "");
    layer.appendChild(rb);
    let b = a;
    const move = ev => {
      b = ptFromEvent(el, ev);
      const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
      Object.assign(rb.style, { left: x0 * S.zoom + "px", top: y0 * S.zoom + "px",
        width: Math.abs(b.x - a.x) * S.zoom + "px", height: Math.abs(b.y - a.y) * S.zoom + "px" });
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const pg = S.doc.pages[i];
      let rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
      const small = rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4;
      if (S.tool === "redact") {
        rb.remove();
        if (small) return toast("Drag over the area to redact");
        REDACT.add(i, rect);             // marked only; removed for good when “Apply redactions” is pressed
        return;
      }
      if (S.tool === "erase") {
        if (small) { rb.remove(); return toast("Drag to draw the area to white out"); }
        await busy(async () => applyInfo(await call("erase", i, rect)));
        window.PDFE_STATS && PDFE_STATS.event("tool_used", { tool: "erase" });
      } else {
        rb.remove();
        if (!S.image) return;
        PLACE.start(i, rect);            // one frame to move and resize; added only when confirmed
        return;
      }
      setTimeout(() => rb.remove(), 400);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

async function pickImage(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    let blob = file;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {     // convert anything else to PNG
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      blob = await new Promise(r => c.toBlob(r, "image/png"));
    }
    S.image = { blob, w: img.naturalWidth, h: img.naturalHeight, name: file.name };
    setTool("image");
  } catch (e) { toast("This image could not be read", true); }
  finally { URL.revokeObjectURL(url); }
}

/* ---------------------------------------------------------------- find & replace */
function openFind() {
  if (!S.doc) return;
  $("#findPanel").hidden = false;
  const sel = String(getSelection() || "").trim();
  if (sel && sel.length < 100 && !S.ed) $("#findInput").value = sel;
  $("#findInput").focus();
  $("#findInput").select();
  if ($("#findInput").value) runFind();
}

function closeFind() {
  $("#findPanel").hidden = true;
  S.hits = []; S.cur = -1;
  drawHits();
}

function findOpts() {
  return { query: $("#findInput").value, matchCase: $("#optCase").checked, wholeWord: $("#optWord").checked };
}

let findSeq = 0;
async function runFind(keepIndex) {
  if (!S.doc) return;
  const o = findOpts();
  const seq = ++findSeq;
  if (!o.query) { S.hits = []; S.cur = -1; drawHits(); updateFindUI(); return; }
  let r;
  try { r = { hits: await call("find", o.query, o.matchCase, o.wholeWord) }; } catch (e) { return toast(e.message, true); }
  if (seq !== findSeq) return;
  const prev = S.cur;
  S.hits = r.hits;
  if (!S.hits.length) S.cur = -1;
  else if (keepIndex && prev >= 0) S.cur = Math.min(prev, S.hits.length - 1);
  else {
    const k = S.hits.findIndex(h => h.page >= S.current);
    S.cur = k < 0 ? 0 : k;
  }
  drawHits();
  updateFindUI();
  if (!keepIndex) revealHit();
}

function updateFindUI() {
  const n = S.hits.length, q = $("#findInput").value;
  $("#findCount").textContent = !q ? "Type to search" : n ? `${S.cur + 1} of ${n}` : "No match";
  $("#btnPrev").disabled = $("#btnNext").disabled = n < 2;
  $("#btnReplaceOne").disabled = $("#btnReplaceAll").disabled = !n;
}

function drawHits() {
  $$("#pages .hits").forEach(h => (h.innerHTML = ""));
  if (!S.doc) return;
  S.hits.forEach((h, k) => {
    const el = pageEl(h.page);
    if (!el) return;
    const d = document.createElement("div");
    d.className = "hit" + (k === S.cur ? " current" : "");
    const [x0, y0, x1, y1] = h.bbox, z = S.zoom;
    Object.assign(d.style, { left: x0 * z - 1 + "px", top: y0 * z + "px", width: (x1 - x0) * z + 2 + "px", height: (y1 - y0) * z + "px" });
    $(".hits", el).appendChild(d);
  });
}

function revealHit() {
  const h = S.hits[S.cur];
  if (!h) return;
  const el = pageEl(h.page), v = $("#viewer");
  const y = el.offsetTop + h.bbox[1] * S.zoom;
  const x = el.offsetLeft + h.bbox[0] * S.zoom;
  if (y < v.scrollTop + 60 || y > v.scrollTop + v.clientHeight - 80) v.scrollTo({ top: y - v.clientHeight / 3, behavior: "smooth" });
  if (x < v.scrollLeft || x > v.scrollLeft + v.clientWidth - 60) v.scrollLeft = x - 60;
}

function stepHit(d) {
  if (!S.hits.length) return;
  S.cur = (S.cur + d + S.hits.length) % S.hits.length;
  drawHits(); updateFindUI(); revealHit();
}

async function replaceOne() {
  const h = S.hits[S.cur];
  if (!h) return;
  const k = S.hits.slice(0, S.cur).filter(x => x.page === h.page).length;
  await busy(async () => {
    const o = findOpts();
    const r = await call("replaceAll", o.query, $("#replaceInput").value, o.matchCase, o.wholeWord, [h.page, k]);
    applyInfo(r);
    if (!r.replaced) toast("This match spans text with two different styles: click it with Edit text to change it", true);
    noteFonts(r);
  });
  await runFind(true);
  revealHit();
}

async function replaceAll() {
  const n = S.hits.length;
  if (!n) return;
  await busy(async () => {
    const o = findOpts();
    const r = await call("replaceAll", o.query, $("#replaceInput").value, o.matchCase, o.wholeWord, null);
    window.PDFE_STATS && PDFE_STATS.event("tool_used", { tool: "find" });
    applyInfo(r);
    const pages = r.changed.length;
    let msg = `Replaced ${r.replaced} occurrence${r.replaced > 1 ? "s" : ""} on ${pages} page${pages > 1 ? "s" : ""}`;
    if (r.skipped) msg += ` · ${r.skipped} could not be replaced automatically (mixed styles): edit them by clicking`;
    toast(msg, false, 6000);
    noteFonts(r);
  });
  await runFind(true);
}

function noteFonts(r) {
  const fs = r.fonts || [];
  const fb = fs.filter(f => f.kind === "fallback").map(f => f.label);
  const cp = fs.filter(f => f.kind === "compatible").map(f => f.label);
  $("#findNote").textContent = !fs.length ? "" :
    fb.length ? `Note: the original font is not available for part of the text; drawn with ${fb.join(", ")}.`
    : cp.length ? `Replacement drawn with ${cp.join(", ")} (same character widths as the original).`
    : `Replacement drawn with the original font.`;
}

/* ---------------------------------------------------------------- undo / merge */
async function undoRedo(which) {
  if (!S.doc) return;
  if (S.ed) { closeEditor(false); return; }
  if (which === "undo" ? !S.doc.canUndo : !S.doc.canRedo) return;
  await busy(async () => applyInfo(await call(which)));
  if (!$("#findPanel").hidden && $("#findInput").value) runFind(true);
}

async function mergeFile(file) {
  if (!file || !S.doc) return;
  await busy(async () => {
    const before = S.doc.pages.length;
    applyInfo(await call("merge", new Uint8Array(await file.arrayBuffer())));
    toast(`Added ${S.doc.pages.length - before} page(s) from “${file.name}” at the end`);
    scrollToPage(before);
  });
}

/* ---------------------------------------------------------------- wiring */
/** The letter of a shortcut key, on any keyboard layout: the printed Latin letter when the key has
 *  one (AZERTY, QWERTZ…), otherwise the key's position (Arabic, Hebrew, Cyrillic, Greek… keyboards,
 *  where ⌘Z / Ctrl+Z is the key in the Z position). */
function keyOf(e) {
  const k = e.key || "";
  if (/^[a-z]$/i.test(k)) return k.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code || "");
  return m ? m[1].toLowerCase() : k.toLowerCase();
}
function isTyping(e) {
  const t = e.target;
  return t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
}

/** Shortcut hints in tooltips: ⌘ and ⇧ on a Mac, Ctrl+ and Shift+ elsewhere. */
const MAC_KEYS = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);     // ⌘ keyboards
function localKeys(root = document) {
  if (MAC_KEYS) return;
  for (const el of root.querySelectorAll("[title]")) {
    const t = el.title;
    if (!/[⌘⇧]/.test(t)) continue;
    el.title = t.replace(/ \/ Ctrl\+[A-Z]/, "").replace(/⇧⌘/g, "Ctrl+Shift+").replace(/⌘/g, "Ctrl+");
    if (el.getAttribute("aria-label")) el.setAttribute("aria-label", el.title);
  }
}
function init() {
  $("#btnOpen").onclick = $("#btnOpen2").onclick = () => (window.FILES ? FILES.pick() : $("#fileInput").click());
  $("#fileInput").onchange = e => { openFile(e.target.files[0]); e.target.value = ""; };
  $("#mergeInput").onchange = e => { mergeFile(e.target.files[0]); e.target.value = ""; };
  $("#imageInput").onchange = e => { pickImage(e.target.files[0]); e.target.value = ""; };
  $("#btnMerge").onclick = () => $("#mergeInput").click();
  $("#btnSave").onclick = saveFile;
  $("#btnDownload").onclick = download;
  // after the translation (it looks tooltips up by their English ⌘ text), then for new tooltips too
  const keysLater = () => requestAnimationFrame(() => localKeys());
  if (window.I18N && I18N.ready) I18N.ready.then(() => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", keysLater, { once: true }) : keysLater()));
  else localKeys();
  $("#btnUndo").onclick = () => undoRedo("undo");
  $("#btnRedo").onclick = () => undoRedo("redo");
  $("#btnZoomIn").onclick = () => zoomStep(1);
  $("#btnZoomOut").onclick = () => zoomStep(-1);
  $("#btnZoomLabel").onclick = () => setZoom(fitZoom());
  $$(".tool").forEach(b => (b.onclick = () => {
    if (b.dataset.tool === "image" && S.tool === "image") { S.image = null; }   // pick another picture
    setTool(b.dataset.tool);
  }));
  $("#btnFind").onclick = () => ($("#findPanel").hidden ? openFind() : closeFind());
  $("#btnFindClose").onclick = closeFind;
  let ft;
  const refind = () => { clearTimeout(ft); ft = setTimeout(() => runFind(), 220); };
  $("#findInput").addEventListener("input", refind);
  $("#optCase").onchange = $("#optWord").onchange = () => runFind();
  $("#btnNext").onclick = () => stepHit(1);
  $("#btnPrev").onclick = () => stepHit(-1);
  $("#btnReplaceOne").onclick = replaceOne;
  $("#btnReplaceAll").onclick = replaceAll;
  $("#findInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
    if (e.key === "Escape") closeFind();
  });
  $("#replaceInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); (e.metaKey || e.ctrlKey) ? replaceAll() : replaceOne(); }
    if (e.key === "Escape") closeFind();
  });
  bindEditorBar();

  const v = $("#viewer");
  v.addEventListener("scroll", () => { placeBar(); clearTimeout(v._t); v._t = setTimeout(markCurrent, 60); });
  window.addEventListener("resize", placeBar);
  v.addEventListener("wheel", e => {            // pinch / ⌘-scroll zoom
    if (!S.doc || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = v.getBoundingClientRect();
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.01), e.clientY - r.top);
  }, { passive: false });

  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && keyOf(e) === "o") { e.preventDefault(); window.FILES ? FILES.pick() : $("#fileInput").click(); return; }
    if (!S.doc) return;
    if (mod && keyOf(e) === "s") { e.preventDefault(); if (e.shiftKey && window.FILES) FILES.saveAs(); else saveFile(); return; }
    if (mod && keyOf(e) === "f") { e.preventDefault(); openFind(); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === "-") { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoom(fitZoom()); return; }
    if (isTyping(e)) return;
    if (mod && keyOf(e) === "z") { e.preventDefault(); if (window.PLACE && PLACE.active) { PLACE.cancel(); return; } undoRedo(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && keyOf(e) === "y") { e.preventDefault(); undoRedo("redo"); return; }
    if (mod) return;
    const k = keyOf(e);
    if (k === "e") setTool("edit");

    else if (k === "t") setTool("add");
    else if (k === "w") setTool("erase");
    else if (k === "i") setTool("image");
    else if (k === "r" && window.REDACT) REDACT.start();
    else if (e.key === "Escape" && !$("#findPanel").hidden) closeFind();
    else if (e.key === "Alt") document.body.classList.add("show-boxes");
  });
  document.addEventListener("keyup", e => { if (e.key === "Alt") document.body.classList.remove("show-boxes"); });
  window.addEventListener("blur", () => document.body.classList.remove("show-boxes"));

  // drag & drop a PDF anywhere
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  // dragging a file over the window: on the start screen the drop area lights up, over a PDF an overlay says what happens
  const dragUI = (on) => { document.body.classList.toggle("dragging-file", on); $("#dropOverlay").hidden = !on || !S.doc; };
  window.addEventListener("dragenter", e => { if (hasFiles(e)) { dragDepth++; dragUI(true); } });
  window.addEventListener("dragleave", e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dragUI(false); } });
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove("dragging-file"); $("#dropOverlay").hidden = true;
    const hp = window.FILES ? FILES.handleFromDrop(e.dataTransfer) : null;     // only available during the drop
    const f = [...e.dataTransfer.files].find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (f && hp) return hp.then((h) => { if (h && h.kind === "file") f.__handle = h; openFile(f); });
    if (f) return openFile(f);
    filesFromDrop(e.dataTransfer).then(({ files, folder }) => {
      if (files.some((x) => FONT_RX.test(x.name))) addFonts(files, folder);
      else toast("Drop a PDF file (or font files)", true);
    });
  });

  window.addEventListener("beforeunload", e => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

  document.body.classList.add("tool-edit");
  updateButtons();
  bindWebExtras();
  startEngine().then(async () => {
    $("#engineStatus").textContent = "";
    document.body.classList.add("engine-ready");
    if (!freeFontsOn()) call("setFreeFonts", false);
    if (localFontsPossible() && navigator.permissions) {
      try { const p = await navigator.permissions.query({ name: "local-fonts" }); if (p.state === "granted") useLocalFonts(false); } catch (e) {}
    }
    const rec = await call("restoreInfo").catch(() => null);
    if (rec && !S.doc) showResume(rec);
  }).catch(async (e) => {
    $("#engineStatus").textContent = e.message;
    $("#engineStatus").classList.add("error");
    // find out why: load the engine here, where the browser reports the real error
    try { await import("./engine.js"); $("#engineStatus").textContent += " (the engine itself loads fine here)"; }
    catch (err) { $("#engineStatus").textContent += " – details: " + err.name + ": " + err.message; }
  });
}

/* ---------------------------------------------------------------- web-only extras */
function localFontsPossible() { return "queryLocalFonts" in window && !S.localFonts; }

async function useLocalFonts(interactive) {
  try {
    const list = await window.queryLocalFonts();
    if (!list.length) { if (interactive) toast("The browser did not share any font. Allow “Fonts” for this site (icon left of the address bar), then try again.", true, 9000); return false; }
    S.localFonts = new Map(list.map((f) => [f.postscriptName, f]));
    await refreshFonts(await call("setLocalFonts", list.map((f) => ({ family: f.family, fullName: f.fullName, postscriptName: f.postscriptName, style: f.style }))));
    if (interactive) toast(`${S.fonts.local.length} font families from this computer can now be used`);
    return true;
  } catch (e) {
    if (interactive) toast("Access to this computer's fonts was not allowed. To allow it later: icon left of the address bar → Site settings → Fonts → Allow.", true, 10000);
    return false;
  }
}

/* ---------------------------------------------------------------- fonts from this computer */
const FONT_INTRO_KEY = "pdfe.fontIntroSeen";
const MAX_FONT_FILE = 8 * 1024 * 1024;            // when a whole folder is added
const FONT_RX = /\.(ttf|otf|ttc|otc)$/i;
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
const FONT_DIRS = [
  { label: "Microsoft Office fonts (Calibri, Cambria, Aptos…)", path: "/Applications/Microsoft Word.app/Contents/Resources/DFonts" },
  { label: "Mac fonts (Arial, Times New Roman, Verdana…)", path: "/System/Library/Fonts/Supplemental" },
  { label: "Fonts you installed yourself", path: "~/Library/Fonts" },
];
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const hasInstalledFontsApi = () => "queryLocalFonts" in window;

async function refreshFonts(fonts) {
  S.fonts = fonts;
  S.spans = {};
  if (S.doc) $$("#pages .page").forEach((el) => { el.dataset.spansV = ""; if (el._visible) loadSpans(+el.dataset.i); });
  if (S.ed && S.ed.mode === "edit") {           // refresh the open editor with the exact font
    const ed = S.ed;
    const fresh = (await call("pageText", ed.page)).find((x) => x.id === ed.span.id);
    if (fresh && S.ed === ed) { ed.span = fresh; fontOptions($("#edFont"), fresh.family); syncBar(); previewFont(); }
  }
}

/** Families used by the open PDF that still are not drawn with their exact font. */
async function missingFamilies() {
  if (!S.doc) return [];
  const miss = new Set();
  const n = Math.min(S.doc.pages.length, 3);
  for (let i = 0; i < n; i++) {
    try { for (const sp of await call("pageText", i)) if (sp.family && !["exact", "embedded", "free"].includes(sp.fontKind)) miss.add(sp.family); } catch (e) {}
  }
  return [...miss].sort();
}
function officeNote(fams) {
  const off = fams.filter((f) => /^(calibri|cambria|aptos|candara|consolas|constantia|corbel|segoe|franklin gothic|century gothic|gill sans mt)/i.test(f));
  return off.length ? `${off.join(", ")} ${off.length > 1 ? "come" : "comes"} with Microsoft Office, which does not share ${off.length > 1 ? "them" : "it"} with web browsers: add the Office fonts folder below.` : "";
}

/** Read files picked or dropped (fromFolder: skip very large files). */
async function addFonts(list, fromFolder) {
  const files = [...list].filter((f) => FONT_RX.test(f.name));
  if (!files.length) return toast(list.length ? "No font files there (.ttf, .otf or .ttc)" : "No file chosen", true);
  const total = files.reduce((a, f) => a + f.size, 0);
  await busy(async () => {
    toast(`Reading ${files.length} font file${files.length > 1 ? "s" : ""} (${fmtSize(total)})…`, false, 120000);
    const r = await call("addFontFiles", files, fromFolder ? MAX_FONT_FILE : 0);
    await refreshFonts(r.fonts);
    renderFontList(r.list);
    const large = r.skipped.filter((x) => x.why === "large"), bad = r.skipped.filter((x) => x.why !== "large");
    let msg = r.families.length
      ? `Added ${r.families.length} font famil${r.families.length > 1 ? "ies" : "y"}${r.families.length <= 4 ? ": " + r.families.join(", ") : ""}`
      : "These fonts were already added";
    if (large.length) msg += ` · ${large.length} file${large.length > 1 ? "s" : ""} over 8 MB skipped (${large.slice(0, 3).map((x) => x.name.replace(FONT_RX, "")).join(", ")}${large.length > 3 ? "…" : ""}) – add ${large.length > 1 ? "them" : "it"} with “Add files…” if needed`;
    if (bad.length) msg += ` · ${bad.length} file${bad.length > 1 ? "s" : ""} could not be read (${bad[0].name}: ${bad[0].why})`;
    toast(msg, !r.families.length && bad.length > 0, 9000);
    if (!$("#fontsDlg").hidden) updateFontsDialog();
  });
}

function renderFontList(list) {
  const ul = $("#fontList");
  ul.innerHTML = "";
  for (const f of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="nm"></span><span class="meta"></span><button title="Remove">✕</button>`;
    li.querySelector(".nm").textContent = f.family;
    li.querySelector(".meta").textContent = `${f.styles} style${f.styles > 1 ? "s" : ""} · ${fmtSize(f.bytes)}`;
    li.querySelector("button").onclick = () => removeFonts([f.family]);
    ul.appendChild(li);
  }
  const bytes = list.reduce((a, f) => a + f.bytes, 0);
  $("#fontListCount").textContent = `${list.length} font famil${list.length > 1 ? "ies" : "y"} kept in this browser (${fmtSize(bytes)})`;
  $("#fontListWrap").hidden = !list.length;
}

async function removeFonts(families) {
  const r = await call("removeFontFamilies", families);
  await refreshFonts(r.fonts);
  renderFontList(r.list);
  updateFontsDialog();
}

async function updateFontsDialog() {
  const inst = hasInstalledFontsApi();
  $("#fontsInstalled").hidden = !inst;
  if (inst) {
    $("#fontsInstalledText").textContent = S.localFonts ? "✓ The fonts installed on this computer are used." : "Use the fonts installed on this computer (the browser asks you once).";
    $("#fontsAllow").hidden = !!S.localFonts;
  }
  $("#fontsOffice").hidden = $("#fontsMacFonts").hidden = !IS_MAC;
  $("#freeFonts").checked = freeFontsOn();
  const miss = await missingFamilies();
  $("#fontsMissing").hidden = !miss.length;
  if (miss.length) $("#fontsMissing").textContent = `Not available yet for this PDF: ${miss.join(", ")}. ` + (officeNote(miss) ? "For Office fonts, use “Add Office fonts”." : "");
}

const freeFontsOn = () => ls.get("pdfe.freeFonts") !== "0";
async function setFreeFonts(on) { ls.set("pdfe.freeFonts", on ? "1" : "0"); await call("setFreeFonts", on); if (S.doc) await refreshFonts(S.fonts); }

/** Copy a folder's path and open the folder picker: the person only presses ⌘⇧G, ⌘V, Return. */
function pickFontFolder(path) {
  const ta = document.createElement("textarea");
  ta.value = path; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  $("#fontFolderInput").click();
  toast(copied ? "In the window: press ⌘⇧G, then ⌘V, then Return, then click Upload (the files stay on your Mac)."
               : `In the window: press ⌘⇧G, type ${path}, then Return, then Upload.`, false, 60000);
}

async function openFontsDialog() {
  const d = $("#fontsDlg");
  d.hidden = false;
  renderFontList(await call("userFontFamilies"));
  await updateFontsDialog();
  $("#fontsClose").focus();
}
function closeFontsDialog() { $("#fontsDlg").hidden = true; }

/** The first time an edit had to use a look-alike font: explain once why the computer's fonts
 *  help, and offer to redo that edit with them. */
let fontIntroRetry = null;
async function maybeFontIntro(family, retry) {
  if (ls.get(FONT_INTRO_KEY) || S.localFonts || !$("#fontsDlg").hidden) return;
  const inst = hasInstalledFontsApi();
  if (!inst && !IS_MAC) return;              // nothing simple to offer here
  fontIntroRetry = retry || null;
  $("#fontIntroFams").textContent = family || "this PDF's font";
  $("#fontIntroAllow").hidden = !inst;
  $("#fontIntroFiles").hidden = inst;
  $("#fontIntro").hidden = false;
  (inst ? $("#fontIntroAllow") : $("#fontIntroFiles")).focus();
}
function closeFontIntro() { $("#fontIntro").hidden = true; ls.set(FONT_INTRO_KEY, "1"); }

/** A dropped folder: list the files inside it (all three browsers support this API). */
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.some((e) => e.isDirectory)) return { files: [...dt.files], folder: false };
  const out = [];
  const walk = async (entry, depth) => {
    if (entry.isFile) { if (FONT_RX.test(entry.name)) out.push(await new Promise((res, rej) => entry.file(res, rej))); return; }
    if (depth > 4) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, depth + 1);
    }
  };
  for (const e of entries) await walk(e, 0);
  return { files: out, folder: true };
}

function bindFonts() {
  $("#btnFonts").onclick = openFontsDialog;
  $("#fontsClose").onclick = closeFontsDialog;
  $("#fontsDlg").addEventListener("pointerdown", (e) => { if (e.target === $("#fontsDlg")) closeFontsDialog(); });
  $("#fontsDlg").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeFontsDialog(); } });
  $("#fontsAllow").onclick = async () => { if (await useLocalFonts(true)) updateFontsDialog(); };
  $("#fontsAddFiles").onclick = () => $("#fontFilesInput").click();
  $("#fontsOffice").onclick = () => pickFontFolder(FONT_DIRS[0].path);
  $("#fontsMacFonts").onclick = () => pickFontFolder(FONT_DIRS[1].path);
  $("#freeFonts").onchange = (e) => setFreeFonts(e.target.checked);

  $("#fontFilesInput").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; addFonts(f, false); };
  $("#fontFolderInput").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; $("#toast").classList.remove("show"); addFonts(f, true); };
  $("#fontsRemoveAll").onclick = async () => {
    if (await modal({ title: "Remove all added fonts?", text: "They are removed from this browser only; the files on your computer are not touched.", ok: "Remove" })) removeFonts(["*"]);
  };
  $("#fontIntroLater").onclick = closeFontIntro;
  $("#fontIntroFiles").onclick = () => { closeFontIntro(); openFontsDialog(); };
  $("#fontIntroAllow").onclick = async () => {
    const ok = await useLocalFonts(false);     // the click is the user gesture the browser requires
    const retry = fontIntroRetry;
    closeFontIntro();
    if (!ok) return toast("Not allowed – the look-alike font stays. You can allow it later with the Fonts button.", true, 7000);
    if (retry) await busy(retry);
  };
  $("#fontIntro").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeFontIntro(); } });
}

function showResume(rec) {
  if (window.FILES && FILES.setResume) return FILES.setResume(rec);      // shown in the Recent files list
  const box = $("#resume");
  const when = new Date(rec.time).toLocaleString();
  $("#resumeText").textContent = `“${rec.name}” (last edited ${when}) is still in this browser.`;
  box.hidden = false;
  $("#btnResume").onclick = () => busy(async () => { const info = await call("restore"); box.hidden = true; loadDoc(info, true); S.dirty = true; });
  $("#btnDiscard").onclick = async () => { await call("discard"); box.hidden = true; };
}

function bindWebExtras() {
  const lp = $("#langPick");
  if (lp && window.I18N) {
    const bl = I18N.languages.find((l) => l.code === I18N.browser);
    lp.add(new Option(`${I18N.t("Browser language")} (${bl ? bl.name : "English"})`, "auto", false, I18N.auto));
    for (const l of I18N.languages) lp.add(new Option(l.name, l.code, false, !I18N.auto && l.code === I18N.lang));
    lp.onchange = () => I18N.set(lp.value);
  }
  bindFonts();
  $("#btnClose").onclick = async () => {
    if (!S.doc) return;
    await closeEditor(false);
    if (S.dirty && !(await modal({ title: "Close this PDF?", text: "Your edits have not been saved and will be lost.", ok: "Close" }))) return;
    await call("discard");
    S.doc = null; S.dirty = false; S.hits = [];
    document.body.classList.remove("has-doc");
    $("#pages").innerHTML = ""; $("#thumbs").innerHTML = "";
    $("#docName").textContent = "PDF Editor"; document.title = "PDF Editor";
    closeFind();
    updateButtons();
    if (window.FILES) FILES.closed();
    if (window.ACTIVE) ACTIVE.closed();
  };
  $("#btnSidebar").onclick = () => document.body.classList.toggle("show-sidebar");
}

init();
