# Builds web/app.js from static/app.js: the same interface, talking to the in-browser
# engine (worker.js) instead of the local Python server. Every replacement must match once.
import re, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "static" / "app.js").read_text()
reps = []
def R(old, new, count=1):
    reps.append((old, new, count))

# ---------------------------------------------------------------- engine client
R('''async function api(method, path, body, isForm) {
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
}''', '''/* The PDF engine runs in a Web Worker (MuPDF compiled to WebAssembly): files never leave this device. */
let engineWorker = null, callSeq = 0;
const calls = new Map();
let engineReady = null;
function startEngine() {
  engineReady = new Promise((resolve, reject) => {
    try { engineWorker = new Worker("worker.js", { type: "module" }); }
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
function outName(name) { return String(name || "document").replace(/\\.pdf$/i, "").replace(/[\\/\\\\:]/g, "-") + " (edited).pdf"; }
function triggerDownload(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}''')

R('''const faces = {};
function loadFace(url) {
  if (!faces[url]) {
    const name = "pdfe" + Object.keys(faces).length;
    const ff = new FontFace(name, `url(${url})`);
    faces[url] = ff.load().then(f => { document.fonts.add(f); return name; }).catch(() => null);
  }
  return faces[url];
}''', '''const faces = {};
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
}''')
R('''function docUrl(p) { return `/api/doc/${S.doc.id}${p}`; }
''', '')

# ---------------------------------------------------------------- open / save
R('''  closeEditor(false);
  const fd = new FormData();
  fd.append("file", file);
  if (password) fd.append("password", password);
  document.body.classList.add("busy");
  try {
    const info = await api("POST", "/api/open", fd, true);
    loadDoc(info, true);''', '''  closeEditor(false);
  if (S.dirty && S.doc && !(await modal({ title: "Open another PDF?", text: `Your edits to “${S.doc.name}” have not been saved. They will be lost.`, ok: "Open anyway" }))) return;
  document.body.classList.add("busy");
  try {
    await engineReady;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await call("open", bytes, file.name, password);
    $("#resume").hidden = true;
    loadDoc(info, true);''')
R('''  history.replaceState(null, "", "#" + info.id);
''', '')
R('''async function saveDesktop() {
  if (!S.doc) return;
  closeEditor(true);
  await busy(async () => {
    const r = await api("POST", docUrl("/save_desktop"));
    S.dirty = false;
    toast(`Saved to your Desktop: ${r.name}`);
  });
}''', '''async function saveFile() {
  if (!S.doc) return;
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
        toast(`Saved: ${h.name}`);
        return;
      } catch (e) { if (e.name === "AbortError") return; }
    }
    triggerDownload(bytes, name);
    S.dirty = false;
    toast(`Downloaded: ${name}`);
  });
}''')
R('''  closeEditor(true);
  const a = document.createElement("a");
  a.href = docUrl("/download");
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  S.dirty = false;''', '''  closeEditor(true).then(() => busy(async () => {
    const bytes = await call("export");
    triggerDownload(bytes, outName(S.doc.name));
    S.dirty = false;
  }));''')

# ---------------------------------------------------------------- page rendering (canvas)
R('''    el.innerHTML = `<div class="loading">Loading…</div><img class="render" alt="" draggable="false">''',
  '''    el.innerHTML = `<div class="loading">Loading…</div><canvas class="render" width="0" height="0"></canvas>''')
R('''    const img = $("img", el);
    img.onload = () => { const l = $(".loading", el); if (l) l.remove(); };
    bindLayer(el, i);''', '''    bindLayer(el, i);''')
R('''      e.target._visible = e.isIntersecting;
      if (e.isIntersecting) loadPage(i);''', '''      e.target._visible = e.isIntersecting;
      clearTimeout(e.target._freeT);
      if (e.isIntersecting) loadPage(i);
      else e.target._freeT = setTimeout(() => freePage(e.target), 5000);''')
R('''  const src = docUrl(`/page/${i}.png?scale=${renderScale()}&v=${p.v}`);
  const img = $("img", el);
  if (img.dataset.src !== src) { img.dataset.src = src; img.src = src; }
  if (S.tool === "edit") loadSpans(i);
}''', '''  const key = p.v + "@" + renderScale();
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
}''')
R('''    try { spans = (await api("GET", docUrl(`/page/${i}/text`))).spans; }''', '''    try { spans = await call("pageText", i); }''')
R('''          fresh = (await api("GET", docUrl(`/page/${i}/text`))).spans;''', '''          fresh = await call("pageText", i);''')
R('''    d.title = sp.editable ? `${sp.matchedFont} · ${sp.size} pt` : "Tilted text cannot be edited";
    d.addEventListener("mousedown", async e => {''', '''    d.title = sp.editable ? "Click to edit · drag to move" : "Tilted text cannot be edited";
    d.addEventListener("pointerdown", async e => {''')

# thumbnails
R('''<div class="tframe" style="height:${h}px"><img alt="Page ${i + 1}" draggable="false"></div>''',
  '''<div class="tframe" style="height:${h}px"><canvas width="0" height="0" aria-label="Page ${i + 1}"></canvas></div>''')
R('''  const img = $("img", t);
  const src = docUrl(`/page/${i}.png?scale=${Math.min(1, 240 / S.doc.pages[i].w).toFixed(2)}&v=${S.doc.pages[i].v}`);
  if (lazy && img.dataset.src === src) return;
  if (!lazy && !img.dataset.src) return;   // not loaded yet: the observer will do it
  img.dataset.src = src;
  img.src = src;
}''', '''  const c = $("canvas", t);
  const v = S.doc.pages[i].v;
  if (lazy && c.dataset.v === v) return;
  if (!lazy && !c.dataset.v) return;       // not loaded yet: the observer will do it
  c.dataset.v = v;
  call("render", i, Math.min(1, 240 / S.doc.pages[i].w)).then((r) => {
    if (c.dataset.v !== r.v) return;
    c.width = r.w; c.height = r.h;
    c.getContext("2d").putImageData(new ImageData(r.pixels, r.w, r.h), 0, 0);
  }).catch(() => {});
}''')
R('''    const info = await api("POST", docUrl("/page"), { op: act, page: i, angle: 90 });''', '''    const info = await call("pageOp", act, i, 90);''')
R('''    await busy(async () => applyInfo(await api("POST", docUrl("/page"), { op: "move", page: from, to })));''',
  '''    await busy(async () => applyInfo(await call("pageOp", "move", from, 90, to)));''')

# ---------------------------------------------------------------- fonts in the editor
R('''  const g1 = document.createElement("optgroup"); g1.label = "Common";
  S.fonts.preferred.forEach(f => g1.appendChild(new Option(f.label, f.key)));
  const g2 = document.createElement("optgroup"); g2.label = "All installed fonts";
  S.fonts.all.forEach(f => g2.appendChild(new Option(f.label, f.key)));
  sel.add(g1); sel.add(g2);''', '''  const g1 = document.createElement("optgroup"); g1.label = "Included fonts";
  S.fonts.bundled.forEach(f => g1.appendChild(new Option(f.label, f.key)));
  sel.add(g1);
  if (S.fonts.local.length) {
    const g2 = document.createElement("optgroup"); g2.label = "Fonts on this computer";
    S.fonts.local.forEach(f => g2.appendChild(new Option(f.label, f.key)));
    sel.add(g2);
  }
  sel.add(new Option("＋ Fonts from this computer…", "__fonts"));''')
R('''  box.contentEditable = "plaintext-only";''', '''  box.contentEditable = PLAIN ? "plaintext-only" : "true";''', 2)
R('''  fontOptions($("#edFont"), sp.matchedFont.replace(/ Regular$/, ""));''', '''  fontOptions($("#edFont"), sp.family);''')
R('''  if ($("#edFont").selectedIndex < 0) $("#edFont").value = "arial";''', '''  if ($("#edFont").selectedIndex < 0) $("#edFont").value = "b:liberationsans";''')
R('''    let h = sp.exact
      ? `<span class="ok">✓ Same font as the original</span> (${esc(sp.matchedFont)}, ${sp.size} pt)`
      : `<span class="warn">⚠ “${esc(sp.font.replace(/^\\*/, ""))}” isn't installed – closest match: ${esc(sp.matchedFont)}</span>`;''',
  '''    const orig = esc(sp.family || sp.font);
    const same = ["exact", "embedded", "free"].includes(sp.fontKind);
    let h = same ? `<span class="ok">✓</span> ${orig} · ${sp.size} pt`
      : sp.fontKind === "compatible" ? `${orig} · ${sp.size} pt <span class="muted">(look-alike font)</span>`
      : `<span class="warn">${orig} not available</span> · ${sp.size} pt`;
    if (!same) h += localFontsPossible() ? ` · <button class="link" id="edUseLocal">Use my fonts</button>` : ` · <button class="link" id="edAddFont">Add font…</button>`;''')
R('''    info.innerHTML = h + " · Enter = apply, Shift+Enter = new line, Esc = cancel";''',
  '''    info.innerHTML = h + ` <span class="keys">↵ apply · ⇧↵ new line · Esc cancel</span>`;
    const ul = $("#edUseLocal");
    if (ul) ul.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); useLocalFonts(true); };
    const af = $("#edAddFont");
    if (af) af.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); openFontsDialog(); };''')
R('''    info.innerHTML = "Type your text · Enter = apply, Shift+Enter = new line, Esc = cancel";''',
  '''    info.innerHTML = `<span class="keys">↵ apply · ⇧↵ new line · Esc cancel</span>`;''')
R('''  let url;
  if (ed.mode === "edit" && !st.fontKey && st.bold === sp.bold && st.italic === sp.italic && sp.fontId) {
    url = `/api/font/${sp.fontId}`;
  } else {
    const key = st.fontKey || (sp && sp.fontKey) || (sp && sp.serif ? "timesnewroman" : sp && sp.mono ? "couriernew" : "arial");
    url = `/api/fontkey/${encodeURIComponent(key)}?b=${st.bold ? 1 : 0}&i=${st.italic ? 1 : 0}`;
  }
  const generic = sp && sp.serif ? "serif" : sp && sp.mono ? "monospace" : "sans-serif";
  const name = await loadFace(url);''', '''  let id;
  try {
    if (ed.mode === "edit" && !st.fontKey) {
      id = st.bold === sp.bold && st.italic === sp.italic ? sp.previewId : await call("previewForSpan", sp, st.bold, st.italic);
    } else {
      id = await call("previewFor", st.fontKey || "b:liberationsans", st.bold, st.italic);
    }
  } catch (e) { id = null; }
  const generic = sp && sp.serif ? "serif" : sp && sp.mono ? "monospace" : "sans-serif";
  const name = id ? await loadFace(id) : null;''')
R('''  addDefaults: { fontKey: "arial", size: 12, color: "#000000", bold: false, italic: false },''',
  '''  addDefaults: { fontKey: "b:liberationsans", size: 12, color: "#000000", bold: false, italic: false },
  localFonts: null,     // postscriptName -> FontData (Local Font Access API)''')
R('''    S.addDefaults = { fontKey: st.fontKey || "arial", size: +st.size, color: st.color, bold: st.bold, italic: st.italic };''',
  '''    S.addDefaults = { fontKey: st.fontKey || "b:liberationsans", size: +st.size, color: st.color, bold: st.bold, italic: st.italic };''')
R('''      const info = await api("POST", docUrl("/addtext"), { page: ed.page, x: ed.x + 1 / S.zoom, y: base, text,
        fontKey: st.fontKey || "arial", size: +st.size, color: st.color, bold: st.bold, italic: st.italic });''',
  '''      const info = await call("addText", ed.page, ed.x + 1 / S.zoom, base, text,
        { fontKey: st.fontKey || "b:liberationsans", size: +st.size, color: st.color, bold: st.bold, italic: st.italic });''')
R('''    const info = await api("POST", docUrl("/edit"), body);
    applyInfo(info);
    if (info.font && !info.exact && !styled) toast(`Done – drawn with ${info.font} (closest installed match)`);''',
  '''    const info = await call("editSpan", body.page, body.span, body.expected, body.text, body);
    applyInfo(info);
    if (info.font && !styled && info.fontKind === "fallback") toast(`Done – drawn with ${info.font} (closest available font)`);
    else if (info.font && !styled && sp.fontKind === "embedded" && !/embedded/.test(info.font)) toast(`Done – the original font lacks some of these characters, so ${info.font} was used`);''')
R('''  const img = $("img", pageEl(ed.page) || document.createElement("div"));
  if (img && !img.complete) img.addEventListener("load", () => ed.box.remove(), { once: true });
  else ed.box.remove();''', '''  const pel = pageEl(ed.page);
  if (pel) pel.addEventListener("rendered", () => ed.box.remove(), { once: true });
  else ed.box.remove();''')
R('''  if (!S.fonts) S.fonts = await api("GET", "/api/fonts");''', '''  await engineReady;''')

# ---------------------------------------------------------------- pointer events (mouse, pen and touch)
R('''  document.addEventListener("mousedown", e => {
    if (!S.ed) return;''', '''  document.addEventListener("pointerdown", e => {
    if (!S.ed) return;''')
R('''  layer.addEventListener("mousedown", e => {''', '''  layer.addEventListener("pointerdown", e => {''')
R('''      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);''', '''      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);''')
R('''    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);''', '''    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);''')
R('''        await busy(async () => applyInfo(await api("POST", docUrl("/erase"), { page: i, rect })));''',
  '''        await busy(async () => applyInfo(await call("erase", i, rect)));''')
R('''        const fd = new FormData();
        fd.append("file", S.image.blob, "image");
        fd.append("page", i);
        fd.append("rect", rect.map(v => v.toFixed(2)).join(","));
        await busy(async () => applyInfo(await api("POST", docUrl("/image"), fd, true)));''',
  '''        await busy(async () => applyInfo(await call("addImage", i, rect, new Uint8Array(await S.image.blob.arrayBuffer()))));''')

# ---------------------------------------------------------------- find / replace / undo / merge
R('''  try { r = await api("POST", docUrl("/find"), o); } catch (e) { return toast(e.message, true); }''',
  '''  try { r = { hits: await call("find", o.query, o.matchCase, o.wholeWord) }; } catch (e) { return toast(e.message, true); }''')
R('''    const r = await api("POST", docUrl("/replace"), { ...findOpts(), replace: $("#replaceInput").value, only: [h.page, k] });''',
  '''    const o = findOpts();
    const r = await call("replaceAll", o.query, $("#replaceInput").value, o.matchCase, o.wholeWord, [h.page, k]);''')
R('''    const r = await api("POST", docUrl("/replace"), { ...findOpts(), replace: $("#replaceInput").value });''',
  '''    const o = findOpts();
    const r = await call("replaceAll", o.query, $("#replaceInput").value, o.matchCase, o.wholeWord, null);''')
R('''  const off = fs.filter(f => !f.exact).map(f => f.label);
  $("#findNote").textContent = !fs.length ? "" :
    off.length ? `Note: original font not installed for part of the text; drawn with ${off.join(", ")}.`
               : `Replacement drawn with the original font (${fs.map(f => f.label).join(", ")}).`;''',
  '''  const fb = fs.filter(f => f.kind === "fallback").map(f => f.label);
  const cp = fs.filter(f => f.kind === "compatible").map(f => f.label);
  $("#findNote").textContent = !fs.length ? "" :
    fb.length ? `Note: the original font is not available for part of the text; drawn with ${fb.join(", ")}.`
    : cp.length ? `Replacement drawn with ${cp.join(", ")} (same character widths as the original).`
    : `Replacement drawn with the original font.`;''')
R('''  await busy(async () => applyInfo(await api("POST", docUrl("/" + which))));''', '''  await busy(async () => applyInfo(await call(which)));''')
R('''  const fd = new FormData();
  fd.append("file", file);
  await busy(async () => {
    const before = S.doc.pages.length;
    applyInfo(await api("POST", docUrl("/merge"), fd, true));''', '''  await busy(async () => {
    const before = S.doc.pages.length;
    applyInfo(await call("merge", new Uint8Array(await file.arrayBuffer())));''')

# ---------------------------------------------------------------- init
R('''  $("#btnSave").onclick = saveDesktop;''', '''  $("#btnSave").onclick = saveFile;''')
R('''    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveDesktop(); return; }''',
  '''    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); return; }''')
R('''  setInterval(async () => {
    try { await fetch("/api/health", { cache: "no-store" }); $("#offline").hidden = true; }
    catch (e) { $("#offline").hidden = false; }
  }, 60000);
''', '')
R('''  ensureFonts().catch(() => {});
  const sid = location.hash.slice(1);
  if (/^[a-f0-9]{12}$/.test(sid)) api("GET", `/api/doc/${sid}`).then(info => loadDoc(info, true)).catch(() => history.replaceState(null, "", "/"));
}''', '''  bindWebExtras();
  startEngine().then(async () => {
    $("#engineStatus").textContent = "";
    document.body.classList.add("engine-ready");
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
const FONT_RX = /\\.(ttf|otf|ttc|otc)$/i;
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
  const box = $("#resume");
  const when = new Date(rec.time).toLocaleString();
  $("#resumeText").textContent = `“${rec.name}” (last edited ${when}) is still in this browser.`;
  box.hidden = false;
  $("#btnResume").onclick = () => busy(async () => { const info = await call("restore"); box.hidden = true; loadDoc(info, true); S.dirty = true; });
  $("#btnDiscard").onclick = async () => { await call("discard"); box.hidden = true; };
}

function bindWebExtras() {
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
  };
  $("#btnSidebar").onclick = () => document.body.classList.toggle("show-sidebar");
}''')

# ---------------------------------------------------------------- fonts from this computer (wiring)
R('''  $("#edFont").addEventListener("change", e => upd("fontKey", e.target.value));''',
  '''  $("#edFont").addEventListener("change", e => {
    if (e.target.value === "__fonts") { e.target.value = S.ed ? (S.ed.style.fontKey ?? "") : ""; openFontsDialog(); return; }
    upd("fontKey", e.target.value);
  });''')
R('''    if (S.ed.box.contains(e.target) || $("#editorBar").contains(e.target) || !$("#modal").hidden) return;''',
  '''    if (S.ed.box.contains(e.target) || $("#editorBar").contains(e.target) || !$("#modal").hidden || e.target.closest(".dlg, .edgrip")) return;''')
R('''    if (f) openFile(f); else toast("Drop a PDF file", true);''',
  '''    if (f) return openFile(f);
    filesFromDrop(e.dataTransfer).then(({ files, folder }) => {
      if (files.some((x) => FONT_RX.test(x.name))) addFonts(files, folder);
      else toast("Drop a PDF file (or font files)", true);
    });''')
R('''  if (!$("#findPanel").hidden && $("#findInput").value) runFind();
}''', '''  if (!$("#findPanel").hidden && $("#findInput").value) runFind();

}''')
R('''function bindWebExtras() {''', '''function bindWebExtras() {
  bindFonts();''')

# ---------------------------------------------------------------- Move text tool hooks (move.js)
R('''  if (S.tool === "edit") loadSpans(i);
}''', '''  if (S.tool === "edit") loadSpans(i);
}''')
R('''  if (t === "edit") $$("#pages .page").forEach(el => el._visible && loadSpans(+el.dataset.i));''',
  '''  if (t === "edit") $$("#pages .page").forEach(el => el._visible && loadSpans(+el.dataset.i));
  document.body.dispatchEvent(new Event("toolchange"));''')
R('''    n.textContent = "No editable text on this page (scanned image?) – use Whiteout + Add text.";
    el.appendChild(n);
  }''', '''    n.textContent = "No editable text on this page (scanned image?) – use Whiteout + Add text.";
    el.appendChild(n);
  }
  if (typeof mvAfterSpans === "function") mvAfterSpans(i);''')
R('''    if (k === "e") setTool("edit");''', '''    if (k === "e") setTool("edit");
''')

# ---------------------------------------------------------------- moving inside the Edit text tool (move.js)
R('''  S.ed = { mode: "edit", page: pi, span: sp, box, original: text, ox, horizontal,''', '''  S.ed = { mode: "edit", page: pi, span: sp, box, original: text, ox, horizontal, dx: 0, dy: 0,''')
R('''  placeBox();
  fontOptions($("#edFont"), sp.family);''', '''  placeBox();
  if (typeof edAttach === "function") edAttach();
  fontOptions($("#edFont"), sp.family);''')
R('''  bar.style.visibility = (r.bottom < vr.top || r.top > vr.bottom) ? "hidden" : "visible";
}''', '''  bar.style.visibility = (r.bottom < vr.top || r.top > vr.bottom) ? "hidden" : "visible";
  if (typeof edPlaceGrip === "function") edPlaceGrip();
}''')
R('''  if (text === ed.original && !styled) { ed.box.remove(); return; }
  ed.box.contentEditable = "false";
  await busy(async () => {
    const info = await call("editSpan", body.page, body.span, body.expected, body.text, body);
    applyInfo(info);''', '''  const moved = Math.abs(ed.dx || 0) > 0.05 || Math.abs(ed.dy || 0) > 0.05;
  if (text === ed.original && !styled && !moved) { ed.box.remove(); return; }
  if (moved) { body.dx = ed.dx; body.dy = ed.dy; }
  const moveOnly = moved && text === ed.original && !styled;
  ed.box.contentEditable = "false";
  await busy(async () => {
    const info = moveOnly ? await call("moveSpans", body.page, [{ id: sp.id, expected: sp.text }], ed.dx, ed.dy)
                          : await call("editSpan", body.page, body.span, body.expected, body.text, body);
    applyInfo(info);
    // letters drawn with a look-alike font: explain once why the computer's fonts help, then redo it with them
    if (!moveOnly && /Liberation|Carlito|Caladea|DejaVu/.test(info.font || "") && !st.fontKey)
      setTimeout(() => maybeFontIntro(sp.family, async () => { applyInfo(await call("undo")); applyInfo(await call("editSpan", body.page, body.span, body.expected, body.text, body)); }), 400);''')
R('''    if (info.font && !styled && info.fontKind === "fallback") toast(`Done – drawn with ${info.font} (closest available font)`);
    else if (info.font && !styled && sp.fontKind === "embedded" && !/embedded/.test(info.font)) toast(`Done – the original font lacks some of these characters, so ${info.font} was used`);
    else if (st.fit && info.size && info.size < sp.size) toast(`Done – text shrunk to ${info.size} pt to fit`);''',
  '''    if (st.fit && info.size && info.size < sp.size) toast(`Text shrunk to ${info.size} pt to fit`);''')
R('''    $("#engineStatus").textContent = "";
    document.body.classList.add("engine-ready");''', '''    $("#engineStatus").textContent = "";
    document.body.classList.add("engine-ready");
    if (!freeFontsOn()) call("setFreeFonts", false);''')

# ---------------------------------------------------------------- account: save installed fonts used by edits


# ---------------------------------------------------------------- languages (i18n.js)
R('''function bindWebExtras() {''', '''function bindWebExtras() {
  const lp = $("#langPick");
  if (lp && window.I18N) {
    for (const l of I18N.languages) lp.add(new Option(l.name, l.code, false, l.code === I18N.lang));
    lp.onchange = () => I18N.set(lp.value);
  }''')

# focus the editing box at once: the font preview loads afterwards, keystrokes are never lost
R('''  syncBar();
  await previewFont();
  focusEnd(box);''', '''  syncBar();
  focusEnd(box);
  await previewFont();''')
R('''  syncBar();
  await previewFont();
  box.focus();''', '''  syncBar();
  box.focus();
  await previewFont();''')

out = src
for old, new, count in reps:
    n = out.count(old)
    if n != count:
        sys.exit(f"Replacement matched {n} times (expected {count}):\n{old[:200]}")
    out = out.replace(old, new)
leftover = [m for m in ("api(", "docUrl", "/api/", "saveDesktop", "mousedown", "mouseup", "mousemove") if m in out]
if leftover:
    for m in leftover:
        for ln, line in enumerate(out.splitlines(), 1):
            if m in line: print("LEFTOVER", m, ln, line.strip()[:120])
    sys.exit(1)
(root / "web" / "app.js").write_text(out)
print("web/app.js written:", len(out), "bytes,", len(reps), "replacements")
