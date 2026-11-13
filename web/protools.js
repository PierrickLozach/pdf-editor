/* PDF Editor - Pro tools (uses the globals of app.js / tools.js / pro.js):
 * batch processing, compare two PDFs, forms (fill in, add fields), smart redaction (in the Redact bar),
 * the OCR page limit without Pro. Each asks PRO.require(feature) first. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstElementChild; };
  const I = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  const BADGE = `<span class="pro-badge" title="Pro">PRO</span>`;
  const PT = (window.PROTOOLS = { cmp: null });
  const need = (f) => (window.PRO ? PRO.require(f) : Promise.resolve(false));
  const size = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1048576).toFixed(1) + " MB");
  const pickFiles = (accept, multiple) => new Promise((res) => {
    const i = el(`<input type="file" accept="${accept}"${multiple ? " multiple" : ""} hidden>`);
    document.body.appendChild(i);
    i.onchange = () => { res([...i.files]); i.remove(); };
    i.addEventListener("cancel", () => { res([]); i.remove(); });
    i.click();
  });

  /* ---------------------------------------------------------------- Tools menu + start screen */
  const ITEMS = [
    ["batch", "Batch processing", "Several PDFs at once", I('<rect x="7" y="3" width="12" height="15" rx="2"/><path d="M5 7v12a2 2 0 0 0 2 2h9"/>')],
    ["compare", "Compare with another PDF", "See what changed", I('<rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/><path d="M5.5 9h3M15.5 9h3M15.5 13h3"/>')],
    ["addfield", "Add a form field", "A box to fill in, or a checkbox", I('<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 12h6"/>')],
  ];
  const RUN = { batch: () => PT.batch(), compare: () => PT.compare(), addfield: () => PT.addField(), pro: () => PRO.open() };
  function addMenu() {
    const m = document.getElementById("toolsMenu");
    if (!m || m.querySelector('[data-k="batch"]')) return;
    for (const [k, title, sub, icon] of ITEMS) {
      const b = el(`<button role="menuitem" data-k="${k}">${icon}<span><b>${esc(t(title))} ${BADGE}</b><small>${esc(t(sub))}</small></span></button>`);
      b.onclick = () => { TOOLS.menu.close(); window.PDFE_STATS && PDFE_STATS.event("tool_used", { tool: k }); RUN[k](); };
      m.appendChild(b);
    }
    const p = el(`<button role="menuitem" data-k="pro" class="tm-pro">${I('<path d="m12 3 2.6 5.6 6 .6-4.5 4 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.5-4 6-.6z"/>')}<span><b>${esc(t("PDF Editor Pro"))}</b><small class="pro-state">${esc(t("Licence, prices, what is included"))}</small></span></button>`);
    p.onclick = () => { TOOLS.menu.close(); PRO.open(); };
    m.appendChild(p);
    if (window.PRO) PRO.ready.then(() => { if (PRO.state) p.querySelector(".pro-state").textContent = t("Pro is active on this computer."); });
  }
  function startScreen() {
    const fi = document.querySelector("#empty .from-images");
    if (!fi || document.getElementById("btnBatch")) return;
    fi.insertAdjacentHTML("beforeend", ` · <button id="btnBatch" class="link">${esc(t("Process several PDFs at once"))}</button> ${BADGE}`);
    document.getElementById("btnBatch").onclick = () => PT.batch();
  }

  /* ---------------------------------------------------------------- the OCR page limit (free: a few pages per PDF) */
  /** Returns the pages to recognise, or null when the person cancels. */
  PT.ocrPages = async (pages) => {
    if (!window.PRO) return pages;
    await PRO.ready;
    if (PRO.has("ocr")) return pages;
    const lim = (await PRO.getConfig()).freeOcrPages ?? 3;
    if (pages.length <= lim) return pages;
    const v = await TOOLS.ask("ocrLimitDlg", t("Text recognition"), `
      <p>${esc(t("Without Pro, text recognition works on up to {n} pages per PDF.").replace("{n}", lim))}</p>
      <label class="opt"><input type="radio" name="w" value="pro" checked> <span>${esc(t("Recognise all {k} pages with Pro").replace("{k}", pages.length))} ${BADGE}</span></label>
      ${lim ? `<label class="opt"><input type="radio" name="w" value="free"> <span>${esc(t("Recognise only the first {n} pages, for free").replace("{n}", lim))}</span></label>` : ""}`, t("Continue"));
    if (!v) return null;
    if (v.w === "free") return pages.slice(0, lim);
    return (await PRO.open("ocr")) ? pages : null;
  };

  /* ---------------------------------------------------------------- smart redaction (a button in the Redact bar) */
  const KIND = { email: ["email address", "email addresses"], phone: ["phone number", "phone numbers"], iban: ["IBAN", "IBANs"], card: ["card number", "card numbers"], nir: ["social security number", "social security numbers"] };
  function smartButton() {
    const b = document.getElementById("redactBar");
    if (!b || b.querySelector(".rb-smart")) return;
    const s = el(`<button class="rb-smart" title="${esc(t("Find and mark emails, phone numbers, IBANs, card and social security numbers"))}">${esc(t("Find personal data"))} ${BADGE}</button>`);
    b.querySelector(".rb-find").after(s);
    s.onclick = async () => {
      if (!(await need("smartredact"))) return;
      const hits = await busy(() => call("findPersonal"));
      if (!hits.length) return toast(t("No personal data found (emails, phone numbers, IBANs, card or social security numbers)."), false, 6000);
      const n = {};
      for (const h of hits) { REDACT.add(h.page, [h.bbox[0] - 1, h.bbox[1] - 1, h.bbox[2] + 1, h.bbox[3] + 1]); n[h.kind] = (n[h.kind] || 0) + 1; }
      const parts = Object.entries(n).map(([k, c]) => c + " " + t(KIND[k][c > 1 ? 1 : 0]));
      toast(t("Marked: {list}. Check them, unmark any that should stay, then apply.").replace("{list}", parts.join(", ")), false, 9000);
      window.PDFE_STATS && PDFE_STATS.event("tool_used", { tool: "smartredact" });
    };
  }
  new MutationObserver(() => { smartButton(); addMenu(); startScreen(); }).observe(document.body, { childList: true });

  /* ---------------------------------------------------------------- batch processing */
  const ACTIONS = [
    ["merge", "Merge into one PDF"], ["compress", "Reduce file size"], ["numbers", "Add page numbers"], ["watermark", "Add a watermark"],
    ["replace", "Find and replace text"], ["redactpersonal", "Black out personal data"], ["protect", "Protect with a password"],
  ];
  PT.batch = async () => {
    if (!(await need("batch"))) return;
    let files = [];
    const old = document.getElementById("batchDlg"); if (old) old.remove();
    const d = el(`<div id="batchDlg" class="dlg tool-dlg" role="dialog" aria-modal="true" aria-labelledby="batchT"><div class="box wide">
      <div class="dlg-head"><h2 id="batchT">${esc(t("Batch processing"))} ${BADGE}</h2><button class="icon close" title="${esc(t("Close (Esc)"))}">${I('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
      <div class="bt-drop"><button class="bt-pick primary">${esc(t("Choose PDFs…"))}</button> <span class="small muted">${esc(t("or drop them here"))}</span></div>
      <ol class="bt-list"></ol>
      <label class="field">${esc(t("What to do"))} <select name="op">${ACTIONS.map(([k, l]) => `<option value="${k}">${esc(t(l))}</option>`).join("")}</select></label>
      <div class="bt-opts"></div>
      <p class="small muted">${esc(t("Done in this browser: the files are never uploaded. The originals are not changed: you get new files."))}</p>
      <p class="err warnbox" role="alert" hidden></p>
      <div class="actions"><button class="td-cancel">${esc(t("Cancel"))}</button><button class="primary bt-run" disabled>${esc(t("Run"))}</button></div>
    </div></div>`);
    document.body.appendChild(d);
    const list = d.querySelector(".bt-list"), op = d.querySelector('[name="op"]'), opts = d.querySelector(".bt-opts"), run = d.querySelector(".bt-run"), err = d.querySelector(".err");
    const close = () => { d.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey, true);
    d.querySelector(".close").onclick = d.querySelector(".td-cancel").onclick = close;
    const drawList = () => {
      list.innerHTML = files.map((f, i) => `<li><span>${esc(f.name)}</span> <small class="muted">${size(f.size)}</small> <button class="icon bt-x" data-i="${i}" title="${esc(t("Remove from the list"))}">✕</button></li>`).join("");
      list.querySelectorAll(".bt-x").forEach((b) => (b.onclick = () => { files.splice(+b.dataset.i, 1); drawList(); }));
      run.disabled = !files.length || (op.value === "merge" && files.length < 2);
    };
    const add = (fs) => { for (const f of fs) if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") files.push(f); drawList(); };
    d.querySelector(".bt-pick").onclick = async () => add(await pickFiles("application/pdf,.pdf", true));
    d.addEventListener("dragover", (e) => e.preventDefault());
    d.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); add([...e.dataTransfer.files]); });
    const OPTS = {
      compress: `<label class="opt"><input type="radio" name="level" value="smaller" checked> <span>${esc(t("Smaller (good for printing)"))}</span></label><label class="opt"><input type="radio" name="level" value="smallest"> <span>${esc(t("Smallest (for email)"))}</span></label>`,
      numbers: `<label class="field">${esc(t("Format"))} <select name="format"><option value="{n} / {total}">1 / 10</option><option value="{n}">1</option><option value="Page {n} of {total}">${esc(t("Page {n} of {total}").replace("{n}", 1).replace("{total}", 10))}</option></select></label>`,
      watermark: `<label class="field">${esc(t("Text"))} <input name="text" type="text" value="${esc(t("CONFIDENTIAL"))}" maxlength="80"></label>`,
      replace: `<label class="field">${esc(t("Find"))} <input name="find" type="text"></label><label class="field">${esc(t("Replace with"))} <input name="repl" type="text"></label><label class="opt"><input type="checkbox" name="matchCase"> <span>${esc(t("Match case"))}</span></label>`,
      redactpersonal: `<p class="small">${esc(t("Emails, phone numbers, IBANs, card and social security numbers are removed for good from every file. Check the results before sending them."))}</p>`,
      protect: `<label class="field">${esc(t("Password"))} <input name="newPassword" type="password" autocomplete="new-password"></label>`,
      merge: `<p class="small">${esc(t("The PDFs are joined in the order of the list."))}</p>`,
    };
    const drawOpts = () => { opts.innerHTML = OPTS[op.value] || ""; drawList(); };
    op.onchange = drawOpts; drawOpts();
    run.onclick = async () => {
      const v = {}; for (const x of opts.querySelectorAll("[name]")) v[x.name] = x.type === "checkbox" ? x.checked : x.type === "radio" ? (x.checked ? x.value : v[x.name]) : x.value;
      if (op.value === "replace" && !v.find) { err.textContent = t("Enter the text to find."); err.hidden = false; return; }
      if (op.value === "protect" && !(v.newPassword && v.newPassword.length >= 4)) { err.textContent = t("Choose a password of at least 4 characters."); err.hidden = false; return; }
      const what = op.value, list0 = files.slice();
      close();
      const prog = TOOLS.progress(t("Batch processing"));
      let cancelled = false; prog.onCancel(() => { cancelled = true; });
      const out = [], failed = [];
      try {
        if (what === "merge") {
          prog.set(t("Merging {n} PDFs…").replace("{n}", list0.length), 0, 1);
          const items = []; for (const f of list0) items.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
          const r = await call("batchMerge", items);
          prog.close();
          await TOOLS.saveOut(r.bytes, "merged.pdf");
          return toast(t("{n} PDFs merged into one of {p} pages.").replace("{n}", list0.length).replace("{p}", r.pages), false, 7000);
        }
        for (let i = 0; i < list0.length && !cancelled; i++) {
          prog.set(t("File {k} of {n}: {name}").replace("{k}", i + 1).replace("{n}", list0.length).replace("{name}", list0[i].name), i / list0.length, 1 / list0.length);
          try { out.push(await call("batchOne", what, { name: list0[i].name, bytes: new Uint8Array(await list0[i].arrayBuffer()) }, v)); }
          catch (e) { failed.push(list0[i].name + " – " + t(e.message || String(e))); }
        }
        prog.close();
        if (cancelled) return;
        const tag = { compress: "smaller", numbers: "numbered", watermark: "watermarked", replace: "edited", redactpersonal: "redacted", protect: "protected" }[what] || "edited";
        const named = out.map((o) => ({ name: o.name.replace(/\.pdf$/i, "") + ` (${t(tag)}).pdf`, bytes: o.bytes }));
        if (named.length === 1) await TOOLS.saveOut(named[0].bytes, named[0].name);
        else if (named.length) await TOOLS.saveOut(await call("zip", named), "batch.zip");
        toast((named.length ? t("{n} files done.").replace("{n}", named.length) : "") + (failed.length ? " " + t("Not done: {list}").replace("{list}", failed.join("; ")) : ""), !!failed.length, 10000);
      } catch (e) { prog.close(); toast(t(e.message || String(e)), true, 8000); }
    };
  };

  /* ---------------------------------------------------------------- compare with another PDF */
  PT.compare = async () => {
    if (!S.doc || !(await need("compare"))) return;
    const [f] = await pickFiles("application/pdf,.pdf", false);
    if (!f) return;
    await closeEditor(true);
    let res;
    try { res = await busy(async () => call("compareWith", new Uint8Array(await f.arrayBuffer()))); }
    catch (e) { return toast(t(e.message || String(e)), true, 7000); }
    PT.cmp = { name: f.name, res, v: S.doc.pages.map((p) => p.v) };
    PT.redrawCompare();
    panel();
  };
  function panel() {
    const old = document.getElementById("cmpPanel"); if (old) old.remove();
    const c = PT.cmp; if (!c) return;
    const diff = c.res.pages.filter((p) => p.added.length || p.removed.length);
    const rows = diff.map((p) => `<li><button class="link cmp-go" data-p="${p.page}">${esc(t("Page {n}").replace("{n}", p.page + 1))}</button>
      ${p.added.length ? `<span class="cmp-n add">${esc(t("{n} new or changed").replace("{n}", p.added.length))}</span>` : ""}
      ${p.removed.length ? `<details><summary class="cmp-n del">${esc(t("{n} no longer here").replace("{n}", p.removed.length))}</summary><ul>${p.removed.slice(0, 50).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</li>`).join("")
      + c.res.extra.map((p) => `<li>${esc(t("Page {n} is only in “{name}”").replace("{n}", p.page + 1).replace("{name}", c.name))}</li>`).join("");
    const d = el(`<aside id="cmpPanel" class="cmp-panel" role="region" aria-label="${esc(t("Comparison"))}">
      <div class="cmp-head"><b>${esc(t("Compared with “{name}”").replace("{name}", c.name))}</b><button class="icon cmp-x" title="${esc(t("Close the comparison"))}">✕</button></div>
      ${diff.length || c.res.extra.length ? `<p class="small">${esc(t("Highlighted on the pages: what is new or changed in this PDF."))}</p><ul class="cmp-list">${rows}</ul>`
        : `<p>${esc(t("No difference in the text."))}</p>`}
      <p class="small muted">${esc(t("Only the text is compared, line by line (not pictures or layout)."))}</p></aside>`);
    document.body.appendChild(d);
    d.querySelector(".cmp-x").onclick = () => { PT.cmp = null; d.remove(); PT.redrawCompare(); };
    d.querySelectorAll(".cmp-go").forEach((b) => (b.onclick = () => pageEl(+b.dataset.p).scrollIntoView({ block: "start", behavior: "smooth" })));
  }
  PT.redrawCompare = () => {
    document.querySelectorAll(".cmp-hl").forEach((x) => x.remove());
    if (!PT.cmp) return;
    S.doc.pages.forEach((p, i) => { const el = pageEl(i); if (el) drawCompare(i, el, el.querySelector(".spans")); });
  };
  function drawCompare(i, el, layer) {
    const c = PT.cmp, p = c && c.res.pages[i];
    if (!p || !layer || c.v[i] !== S.doc.pages[i].v) return;           // the page was edited since: not shown
    for (const a of p.added) {
      const [x0, y0, x1, y1] = a.bbox, d = document.createElement("div");
      d.className = "cmp-hl"; d.title = t("New or changed:") + " " + a.text;
      Object.assign(d.style, { left: (x0 - 2) * S.zoom + "px", top: (y0 - 1) * S.zoom + "px", width: (x1 - x0 + 4) * S.zoom + "px", height: (y1 - y0 + 2) * S.zoom + "px" });
      layer.appendChild(d);
    }
  }

  /* ---------------------------------------------------------------- forms: fill in */
  const fieldCache = new Map();
  let formHint = null;
  PT.decorate = async (i, el, layer) => {
    if (PT.cmp) drawCompare(i, el, layer);
    const p = S.doc.pages[i], v = p.v;
    let list = fieldCache.get(v);
    if (!list) {
      try { list = await call("formFields", i); } catch (e) { return; }
      fieldCache.set(v, list);
      if (fieldCache.size > 300) fieldCache.delete(fieldCache.keys().next().value);
    }
    if (S.doc.pages[i] !== p || el.dataset.spansV !== v + "@" + S.zoom) return;
    if (list.length && formHint !== S.doc.name) {
      formHint = S.doc.name;
      toast(t("This PDF has a form: click a field to fill it in.") + (window.PRO && !PRO.has("forms") ? " (Pro)" : ""), false, 7000);
    }
    for (const f of list) {
      if (f.readOnly) continue;
      const [x0, y0, x1, y1] = f.bbox, d = document.createElement("div");
      d.className = "ffield ff-" + f.type + (f.checked ? " on" : "");
      d.title = (f.name ? f.name + " – " : "") + t("Click to fill in");
      Object.assign(d.style, { left: x0 * S.zoom + "px", top: y0 * S.zoom + "px", width: (x1 - x0) * S.zoom + "px", height: (y1 - y0) * S.zoom + "px" });
      d.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); fill(i, f, d); });
      layer.appendChild(d);
    }
  };
  async function fill(i, f, box) {
    if (S.tool !== "edit" || !(await need("forms"))) return;
    if (f.type === "checkbox" || f.type === "radiobutton") {
      await busy(async () => applyInfo(await call("setField", i, f.id, !f.checked)));
      return;
    }
    document.querySelectorAll(".ff-input").forEach((x) => x.remove());
    const h = (f.bbox[3] - f.bbox[1]) * S.zoom, fs = Math.max(10, Math.min(16, h * 0.62));
    let inp;
    if (f.type === "combobox" || f.type === "listbox") {
      inp = el(`<select class="ff-input">${f.options.map((o) => `<option${o === f.value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`);
    } else inp = el(f.multiline ? `<textarea class="ff-input"></textarea>` : `<input class="ff-input" type="text">`);
    if (inp.tagName !== "SELECT") inp.value = f.value;
    Object.assign(inp.style, { left: box.style.left, top: box.style.top, width: box.style.width, height: f.multiline ? box.style.height : Math.max(h, 22) + "px", fontSize: fs + "px" });
    box.parentElement.appendChild(inp);
    inp.focus(); if (inp.select) inp.select();
    let done = false;
    const commit = async (keep) => {
      if (done) return; done = true;
      const val = inp.value; inp.remove();
      if (keep && val !== f.value) await busy(async () => applyInfo(await call("setField", i, f.id, val)));
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commit(false); }
      else if (e.key === "Enter" && !(f.multiline && e.shiftKey) && inp.tagName !== "TEXTAREA") { e.preventDefault(); commit(true); }
      e.stopPropagation();
    });
    inp.addEventListener("change", () => { if (inp.tagName === "SELECT") commit(true); });
    inp.addEventListener("blur", () => commit(true));
    inp.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  /* ---------------------------------------------------------------- forms: add a field (draw it on the page) */
  let drawing = null;
  PT.addField = async () => {
    if (!S.doc || !(await need("forms"))) return;
    const v = await TOOLS.ask("fieldDlg", t("Add a form field"), `
      <label class="opt"><input type="radio" name="type" value="text" checked> <span>${esc(t("A box to type in"))}</span></label>
      <label class="opt"><input type="radio" name="type" value="checkbox"> <span>${esc(t("A checkbox"))}</span></label>
      <label class="field">${esc(t("Name (shown to people filling it in)"))} <input name="name" type="text" maxlength="60" placeholder="${esc(t("e.g. Full name"))}"></label>`, t("Draw it on the page"));
    if (!v) return;
    await closeEditor(true);
    drawing = { type: v.type, name: v.name };
    document.body.classList.add("drawing-field");
    toast(t("Drag on the page where the field goes. Esc cancels."), false, 6000);
  };
  const stopDrawing = () => { drawing = null; document.body.classList.remove("drawing-field"); document.querySelectorAll(".ff-draft").forEach((x) => x.remove()); };
  document.addEventListener("keydown", (e) => { if (drawing && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopDrawing(); } }, true);
  document.addEventListener("pointerdown", (e) => {
    if (!drawing || e.button !== 0) return;
    const pg = e.target.closest("#pages .page");
    if (!pg) { if (!e.target.closest(".dlg, #toolbar")) stopDrawing(); return; }
    e.preventDefault(); e.stopPropagation();
    const i = +pg.dataset.i, r0 = pg.getBoundingClientRect(), z = S.zoom;
    const a = [(e.clientX - r0.left) / z, (e.clientY - r0.top) / z];
    const draft = el(`<div class="ff-draft"></div>`); pg.querySelector(".layer").appendChild(draft);
    let b = [a[0], a[1], a[0], a[1]];
    const move = (ev) => {
      const p = [(ev.clientX - r0.left) / z, (ev.clientY - r0.top) / z];
      b = [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[0], p[0]), Math.max(a[1], p[1])];
      if (drawing.type === "checkbox") { const s = Math.max(b[2] - b[0], b[3] - b[1], 10); b = [a[0], a[1], a[0] + s, a[1] + s]; }
      Object.assign(draft.style, { left: b[0] * z + "px", top: b[1] * z + "px", width: (b[2] - b[0]) * z + "px", height: (b[3] - b[1]) * z + "px" });
    };
    const up = async () => {
      removeEventListener("pointermove", move, true); removeEventListener("pointerup", up, true);
      const d = drawing; stopDrawing();
      if (b[2] - b[0] < 6 && b[3] - b[1] < 6) b = d.type === "checkbox" ? [a[0], a[1], a[0] + 12, a[1] + 12] : [a[0], a[1], a[0] + 160, a[1] + 18];   // a click: a field of usual size
      try {
        const r = await busy(async () => call("addField", i, b.map((x) => Math.round(x * 10) / 10), d.type, d.name));
        applyInfo(r);
        toast(t("Field “{name}” added. People can fill it in with any PDF reader.").replace("{name}", r.name), false, 7000);
      } catch (x) { toast(t(x.message || String(x)), true, 6000); }
    };
    addEventListener("pointermove", move, true); addEventListener("pointerup", up, true);
  }, true);

  // a change of document drops the comparison and the cached fields of other documents
  PT.docChanged = () => { PT.cmp = null; const p = document.getElementById("cmpPanel"); if (p) p.remove(); fieldCache.clear(); stopDrawing(); };
})();
// arriving from the landing page's "See Pro in the editor" (/app/#pro): show the Pro window
if (location.hash === "#pro") window.addEventListener("load", () => setTimeout(() => { if (window.PRO) { history.replaceState(null, "", location.pathname); PRO.open(); } }, 600));
