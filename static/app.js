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
  addDefaults: { fontKey: "arial", size: 12, color: "#000000", bold: false, italic: false },
  ed: null,             // active inline editor
  current: 0,
};

/* ---------------------------------------------------------------- helpers */
async function api(method, path, body, isForm) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) opt.body = body;
    else { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  }
  let r;
  try { r = await fetch(path, opt); }
  catch (e) { $("#offline").hidden = false; throw new Error("The PDF Editor engine is not running"); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : null;
  if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
  return data;
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
function loadFace(url) {
  if (!faces[url]) {
    const name = "pdfe" + Object.keys(faces).length;
    const ff = new FontFace(name, `url(${url})`);
    faces[url] = ff.load().then(f => { document.fonts.add(f); return name; }).catch(() => null);
  }
  return faces[url];
}

function renderScale() {
  return Math.min(4, Math.ceil(S.zoom * (window.devicePixelRatio || 1) * 4) / 4);
}

function docUrl(p) { return `/api/doc/${S.doc.id}${p}`; }

/* ---------------------------------------------------------------- open / save */
async function openFile(file, password) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return toast("Please choose a PDF file", true);
  closeEditor(false);
  const fd = new FormData();
  fd.append("file", file);
  if (password) fd.append("password", password);
  document.body.classList.add("busy");
  try {
    const info = await api("POST", "/api/open", fd, true);
    loadDoc(info, true);
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
  S.doc = info;
  S.spans = {};
  S.hits = []; S.cur = -1;
  S.dirty = false;
  history.replaceState(null, "", "#" + info.id);
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

async function saveDesktop() {
  if (!S.doc) return;
  closeEditor(true);
  await busy(async () => {
    const r = await api("POST", docUrl("/save_desktop"));
    S.dirty = false;
    toast(`Saved to your Desktop: ${r.name}`);
  });
}

function download() {
  if (!S.doc) return;
  closeEditor(true);
  const a = document.createElement("a");
  a.href = docUrl("/download");
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  S.dirty = false;
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
      if (e.isIntersecting) loadPage(i);
    }
  }, { root: $("#viewer"), rootMargin: "900px 0px" });
  S.doc.pages.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.i = i;
    el.style.width = p.w * S.zoom + "px";
    el.style.height = p.h * S.zoom + "px";
    el.innerHTML = `<div class="loading">Loading…</div><img class="render" alt="" draggable="false">
      <div class="layer"><div class="spans"></div><div class="hits"></div></div><div class="pnum">${i + 1} / ${S.doc.pages.length}</div>`;
    const img = $("img", el);
    img.onload = () => { const l = $(".loading", el); if (l) l.remove(); };
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
  const src = docUrl(`/page/${i}.png?scale=${renderScale()}&v=${p.v}`);
  const img = $("img", el);
  if (img.dataset.src !== src) { img.dataset.src = src; img.src = src; }
  if (S.tool === "edit") loadSpans(i);
}

function refreshPage(i) {
  const el = pageEl(i);
  if (!el) return;
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
    try { spans = (await api("GET", docUrl(`/page/${i}/text`))).spans; }
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
    d.title = sp.editable ? `${sp.matchedFont} · ${sp.size} pt` : "Tilted text cannot be edited";
    d.addEventListener("mousedown", async e => {
      if (S.tool !== "edit" || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (!sp.editable) return toast("This text is tilted: it can't be edited in place. Use Whiteout + Add text instead.", true);
      const v0 = p.v;
      if (S.pending) await S.pending;
      let target = sp;
      if (S.doc.pages[i].v !== v0) {      // the page was just edited: find the same text again
        let fresh = S.spans[S.doc.pages[i].v];
        if (!fresh) {
          fresh = (await api("GET", docUrl(`/page/${i}/text`))).spans;
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
  const old = $(".notext", el); if (old) old.remove();
  if (!spans.length) {
    const n = document.createElement("div");
    n.className = "notext";
    n.textContent = "No editable text on this page (scanned image?) – use Whiteout + Add text.";
    el.appendChild(n);
  }
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
    t.innerHTML = `<div class="tframe" style="height:${h}px"><img alt="Page ${i + 1}" draggable="false"></div>
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
    bindThumbDrag(t);
    box.appendChild(t);
    thumbObserver.observe(t);
  });
  markCurrent();
}

function refreshThumb(i, lazy) {
  const t = $(`#thumbs .thumb[data-i="${i}"]`);
  if (!t || !S.doc.pages[i]) return;
  const img = $("img", t);
  const src = docUrl(`/page/${i}.png?scale=${Math.min(1, 240 / S.doc.pages[i].w).toFixed(2)}&v=${S.doc.pages[i].v}`);
  if (lazy && img.dataset.src === src) return;
  if (!lazy && !img.dataset.src) return;   // not loaded yet: the observer will do it
  img.dataset.src = src;
  img.src = src;
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
    const info = await api("POST", docUrl("/page"), { op: act, page: i, angle: 90 });
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
    await busy(async () => applyInfo(await api("POST", docUrl("/page"), { op: "move", page: from, to })));
  });
}

/* ---------------------------------------------------------------- inline editor */
function fontOptions(sel, original) {
  sel.innerHTML = "";
  if (original) {
    const o = new Option(`Original – ${original}`, "");
    sel.add(o);
  }
  const g1 = document.createElement("optgroup"); g1.label = "Common";
  S.fonts.preferred.forEach(f => g1.appendChild(new Option(f.label, f.key)));
  const g2 = document.createElement("optgroup"); g2.label = "All installed fonts";
  S.fonts.all.forEach(f => g2.appendChild(new Option(f.label, f.key)));
  sel.add(g1); sel.add(g2);
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
  box.contentEditable = "plaintext-only";
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
  S.ed = { mode: "edit", page: pi, span: sp, box, original: text, ox, horizontal,
           style: { fontKey: "", size: sp.size, color: sp.color, bold: sp.bold, italic: sp.italic, fit: false,
                    align: horizontal ? (sp.align || "left") : "left" } };
  placeBox();
  fontOptions($("#edFont"), sp.matchedFont.replace(/ Regular$/, ""));
  syncBar();
  await previewFont();
  focusEnd(box);
}

async function startAdd(pi, x, y) {
  closeEditor(true);
  await ensureFonts();
  const el = pageEl(pi);
  const z = S.zoom;
  const d = S.addDefaults;
  const box = document.createElement("div");
  box.className = "editbox add";
  box.contentEditable = "plaintext-only";
  box.spellcheck = false;
  Object.assign(box.style, { left: x * z + "px", top: y * z + "px", fontSize: d.size * z + "px", color: d.color, background: "transparent" });
  $(".layer", el).appendChild(box);
  S.ed = { mode: "add", page: pi, box, x, y, original: "", style: { ...d, fit: false } };
  fontOptions($("#edFont"), null);
  syncBar();
  await previewFont();
  box.focus();
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
  if ($("#edFont").selectedIndex < 0) $("#edFont").value = "arial";
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
    let h = sp.exact
      ? `<span class="ok">✓ Same font as the original</span> (${esc(sp.matchedFont)}, ${sp.size} pt)`
      : `<span class="warn">⚠ “${esc(sp.font.replace(/^\*/, ""))}” isn't installed – closest match: ${esc(sp.matchedFont)}</span>`;
    if (sp.garbled) h += ` · <span class="warn">this PDF hides its real characters; check the text before applying</span>`;
    info.innerHTML = h + " · Enter = apply, Shift+Enter = new line, Esc = cancel";
  } else {
    info.innerHTML = "Type your text · Enter = apply, Shift+Enter = new line, Esc = cancel";
  }
  $("#editorBar").hidden = false;
  placeBar();
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

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
}

async function previewFont() {
  const ed = S.ed;
  if (!ed) return;
  const st = ed.style, box = ed.box, sp = ed.span;
  let url;
  if (ed.mode === "edit" && !st.fontKey && st.bold === sp.bold && st.italic === sp.italic && sp.fontId) {
    url = `/api/font/${sp.fontId}`;
  } else {
    const key = st.fontKey || (sp && sp.fontKey) || (sp && sp.serif ? "timesnewroman" : sp && sp.mono ? "couriernew" : "arial");
    url = `/api/fontkey/${encodeURIComponent(key)}?b=${st.bold ? 1 : 0}&i=${st.italic ? 1 : 0}`;
  }
  const generic = sp && sp.serif ? "serif" : sp && sp.mono ? "monospace" : "sans-serif";
  const name = await loadFace(url);
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
    S.addDefaults = { fontKey: st.fontKey || "arial", size: +st.size, color: st.color, bold: st.bold, italic: st.italic };
    const base = ed.y + lineBox(+st.size, 0.905, -0.212) / 1;
    await busy(async () => {
      const info = await api("POST", docUrl("/addtext"), { page: ed.page, x: ed.x + 1 / S.zoom, y: base, text,
        fontKey: st.fontKey || "arial", size: +st.size, color: st.color, bold: st.bold, italic: st.italic });
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
  if (text === ed.original && !styled) { ed.box.remove(); return; }
  ed.box.contentEditable = "false";
  await busy(async () => {
    const info = await api("POST", docUrl("/edit"), body);
    applyInfo(info);
    if (info.font && !info.exact && !styled) toast(`Done – drawn with ${info.font} (closest installed match)`);
    else if (st.fit && info.size && info.size < sp.size) toast(`Done – text shrunk to ${info.size} pt to fit`);
  });
  // keep the box until the new render has arrived, so the page doesn't flash
  const img = $("img", pageEl(ed.page) || document.createElement("div"));
  if (img && !img.complete) img.addEventListener("load", () => ed.box.remove(), { once: true });
  else ed.box.remove();
  setTimeout(() => ed.box.remove(), 3000);
}

async function ensureFonts() {
  if (!S.fonts) S.fonts = await api("GET", "/api/fonts");
}

function bindEditorBar() {
  const upd = async (k, v) => { if (!S.ed) return; S.ed.style[k] = v; await previewFont(); };
  $("#edFont").addEventListener("change", e => upd("fontKey", e.target.value));
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
  $("#editorBar").addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); closeEditor(true); }
  });
  document.addEventListener("keydown", e => {
    if (!S.ed || e.target !== S.ed.box) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); closeEditor(true); }
    else if (e.key === "Escape") { e.preventDefault(); closeEditor(false); }
  });
  document.addEventListener("paste", e => {
    if (!S.ed || e.target !== S.ed.box) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\r/g, ""));
  });
  // a click elsewhere applies the change (like Acrobat)
  document.addEventListener("mousedown", e => {
    if (!S.ed) return;
    if (S.ed.box.contains(e.target) || $("#editorBar").contains(e.target) || !$("#modal").hidden) return;
    closeEditor(true);
  }, true);
}

/* ---------------------------------------------------------------- tools on the page */
function setTool(t) {
  if (!S.doc) return;
  closeEditor(true);
  if (t === "image") {
    if (!S.image) { $("#imageInput").click(); return; }   // the tool is set once a picture is chosen
  }
  S.tool = t;
  document.body.className = document.body.className.replace(/\btool-\w+/g, "").trim() + " tool-" + t;
  $$(".tool").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  if (t === "edit") $$("#pages .page").forEach(el => el._visible && loadSpans(+el.dataset.i));
  if (t === "image" && S.image) toast(`Click on a page to place “${S.image.name}”, or drag to choose its size`);
  if (t === "erase") toast("Drag over the area to white out – text under it is really removed");
  if (t === "add") toast("Click where the new text should start");
}

function ptFromEvent(el, e) {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}

function bindLayer(el, i) {
  const layer = $(".layer", el);
  layer.addEventListener("mousedown", e => {
    if (e.button !== 0 || e.target.closest(".editbox")) return;
    if (S.tool === "add") {
      e.preventDefault();
      const p = ptFromEvent(el, e);
      setTimeout(() => startAdd(i, p.x, p.y), 0);
      return;
    }
    if (S.tool !== "erase" && S.tool !== "image") return;
    e.preventDefault();
    const a = ptFromEvent(el, e);
    const rb = document.createElement("div");
    rb.className = "rubber" + (S.tool === "erase" ? " erase" : "");
    layer.appendChild(rb);
    let b = a;
    const move = ev => {
      b = ptFromEvent(el, ev);
      const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
      Object.assign(rb.style, { left: x0 * S.zoom + "px", top: y0 * S.zoom + "px",
        width: Math.abs(b.x - a.x) * S.zoom + "px", height: Math.abs(b.y - a.y) * S.zoom + "px" });
    };
    const up = async () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const pg = S.doc.pages[i];
      let rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
      const small = rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4;
      if (S.tool === "erase") {
        if (small) { rb.remove(); return toast("Drag to draw the area to white out"); }
        await busy(async () => applyInfo(await api("POST", docUrl("/erase"), { page: i, rect })));
      } else {
        if (small) {   // a click: default width 160 pt, keep the picture's proportions
          const w = Math.min(160, pg.w - a.x), h = w * S.image.h / S.image.w;
          rect = [a.x, a.y, a.x + w, a.y + h];
        }
        const fd = new FormData();
        fd.append("file", S.image.blob, "image");
        fd.append("page", i);
        fd.append("rect", rect.map(v => v.toFixed(2)).join(","));
        await busy(async () => applyInfo(await api("POST", docUrl("/image"), fd, true)));
      }
      setTimeout(() => rb.remove(), 400);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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
  try { r = await api("POST", docUrl("/find"), o); } catch (e) { return toast(e.message, true); }
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
    const r = await api("POST", docUrl("/replace"), { ...findOpts(), replace: $("#replaceInput").value, only: [h.page, k] });
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
    const r = await api("POST", docUrl("/replace"), { ...findOpts(), replace: $("#replaceInput").value });
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
  const off = fs.filter(f => !f.exact).map(f => f.label);
  $("#findNote").textContent = !fs.length ? "" :
    off.length ? `Note: original font not installed for part of the text; drawn with ${off.join(", ")}.`
               : `Replacement drawn with the original font (${fs.map(f => f.label).join(", ")}).`;
}

/* ---------------------------------------------------------------- undo / merge */
async function undoRedo(which) {
  if (!S.doc) return;
  if (S.ed) { closeEditor(false); return; }
  if (which === "undo" ? !S.doc.canUndo : !S.doc.canRedo) return;
  await busy(async () => applyInfo(await api("POST", docUrl("/" + which))));
  if (!$("#findPanel").hidden && $("#findInput").value) runFind(true);
}

async function mergeFile(file) {
  if (!file || !S.doc) return;
  const fd = new FormData();
  fd.append("file", file);
  await busy(async () => {
    const before = S.doc.pages.length;
    applyInfo(await api("POST", docUrl("/merge"), fd, true));
    toast(`Added ${S.doc.pages.length - before} page(s) from “${file.name}” at the end`);
    scrollToPage(before);
  });
}

/* ---------------------------------------------------------------- wiring */
function isTyping(e) {
  const t = e.target;
  return t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
}

function init() {
  $("#btnOpen").onclick = $("#btnOpen2").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = e => { openFile(e.target.files[0]); e.target.value = ""; };
  $("#mergeInput").onchange = e => { mergeFile(e.target.files[0]); e.target.value = ""; };
  $("#imageInput").onchange = e => { pickImage(e.target.files[0]); e.target.value = ""; };
  $("#btnMerge").onclick = () => $("#mergeInput").click();
  $("#btnSave").onclick = saveDesktop;
  $("#btnDownload").onclick = download;
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
    if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); $("#fileInput").click(); return; }
    if (!S.doc) return;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveDesktop(); return; }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === "-") { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoom(fitZoom()); return; }
    if (isTyping(e)) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); undoRedo("redo"); return; }
    if (mod) return;
    const k = e.key.toLowerCase();
    if (k === "e") setTool("edit");
    else if (k === "t") setTool("add");
    else if (k === "w") setTool("erase");
    else if (k === "i") setTool("image");
    else if (e.key === "Escape" && !$("#findPanel").hidden) closeFind();
    else if (e.key === "Alt") document.body.classList.add("show-boxes");
  });
  document.addEventListener("keyup", e => { if (e.key === "Alt") document.body.classList.remove("show-boxes"); });
  window.addEventListener("blur", () => document.body.classList.remove("show-boxes"));

  // drag & drop a PDF anywhere
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", e => { if (hasFiles(e)) { dragDepth++; $("#dropOverlay").hidden = false; } });
  window.addEventListener("dragleave", e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $("#dropOverlay").hidden = true;
    const f = [...e.dataTransfer.files].find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (f) openFile(f); else toast("Drop a PDF file", true);
  });

  window.addEventListener("beforeunload", e => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });
  setInterval(async () => {
    try { await fetch("/api/health", { cache: "no-store" }); $("#offline").hidden = true; }
    catch (e) { $("#offline").hidden = false; }
  }, 60000);

  document.body.classList.add("tool-edit");
  updateButtons();
  ensureFonts().catch(() => {});
  const sid = location.hash.slice(1);
  if (/^[a-f0-9]{12}$/.test(sid)) api("GET", `/api/doc/${sid}`).then(info => loadDoc(info, true)).catch(() => history.replaceState(null, "", "/"));
}

init();
