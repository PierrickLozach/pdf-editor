/* PDF Editor - the Tools menu and its tools (uses the globals of app.js).
 *  Sign · Redact · Make searchable (OCR) · Split or extract pages · Convert · Protect with a password ·
 *  Page numbers · Watermark · Reduce file size; and "Create a PDF from pictures" on the start screen.
 *  Everything runs in this browser: files are never uploaded. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const base = (name) => String(name || (S.doc && S.doc.name) || "document").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\/\\:*?"<>|]/g, "-");
  const TOOLS = (window.TOOLS = { esc, base });

  /* ---------------------------------------------------------------- saving what a tool makes */
  const TYPES = { pdf: ["application/pdf", "PDF document"], zip: ["application/zip", "ZIP archive"], docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word document"],
    txt: ["text/plain", "Text"], png: ["image/png", "PNG image"], jpg: ["image/jpeg", "JPEG image"] };
  /** A new file: Chrome and Edge ask where to save it; other browsers download it. */
  TOOLS.saveOut = async (bytes, name) => {
    const ext = name.split(".").pop().toLowerCase(), [mime, label] = TYPES[ext] || ["application/octet-stream", "File"];
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: t(label), accept: { [mime]: ["." + ext] } }] });
        const w = await h.createWritable();
        try { await w.write(bytes); await w.close(); } catch (e) { try { await w.abort(); } catch (x) {} throw e; }
        toast(t("Saved in “{name}”").replace("{name}", h.name));
        return true;
      } catch (e) { if (e.name === "AbortError") return false; }
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(t("Downloaded “{name}”").replace("{name}", name));
    return true;
  };

  /** "1-3, 5, 8-" on an n-page PDF -> [[0, 1, 2], [4], [7 … n-1]], or null when it does not fit. */
  TOOLS.ranges = (str, n) => {
    const out = [];
    for (const part of String(str).split(/[,;]+/)) {
      const p = part.trim();
      if (!p) continue;
      let a, b, m;
      if ((m = /^(\d+)$/.exec(p))) a = b = +m[1];
      else if ((m = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(p))) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
      else return null;
      if (a < 1 || b > n || a > b) return null;
      out.push(Array.from({ length: b - a + 1 }, (_, k) => a - 1 + k));
    }
    return out.length ? out : null;
  };
  const rangeLabel = (p) => (p.length === 1 ? `p${p[0] + 1}` : p.every((v, i) => !i || v === p[i - 1] + 1) ? `p${p[0] + 1}-${p[p.length - 1] + 1}` : `p${p[0] + 1}+`);

  /* ---------------------------------------------------------------- a small window for a tool */
  /** Resolves the values of the window's fields ({name: value}) on OK, or null on Cancel / Esc.
   *  check(values) may return a message to show instead of closing. */
  TOOLS.ask = (id, title, body, okLabel, check) => {
    const old = document.getElementById(id);
    if (old) old.remove();
    const d = el(`<div id="${id}" class="dlg tool-dlg" role="dialog" aria-modal="true" aria-labelledby="${id}T"><div class="box">
      <div class="dlg-head"><h2 id="${id}T">${esc(title)}</h2><button class="icon close" title="${esc(t("Close (Esc)"))}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="tool-body">${body}</div>
      <p class="err warnbox" role="alert" hidden></p>
      <div class="actions"><button class="td-cancel">${esc(t("Cancel"))}</button><button class="primary td-ok">${esc(okLabel)}</button></div>
    </div></div>`);
    document.body.appendChild(d);
    const box = d.querySelector(".tool-body");
    setTimeout(() => (box.querySelector("input[type=text], input[type=password], input[type=number], select") || d.querySelector(".td-ok")).focus(), 30);
    const values = () => {
      const v = {};
      for (const x of box.querySelectorAll("[name]")) {
        if (x.type === "radio") { if (x.checked) v[x.name] = x.value; }
        else if (x.type === "checkbox") v[x.name] = x.checked;
        else v[x.name] = x.value;
      }
      return v;
    };
    return new Promise((res) => {
      let done = (v) => { d.remove(); res(v); };
      const submit = async () => {
        const v = values();
        const err = check ? await check(v, d) : null;
        if (err) { const p = d.querySelector(".err"); p.textContent = err; p.hidden = false; return; }
        done(v);
      };
      d.querySelector(".close").onclick = d.querySelector(".td-cancel").onclick = () => done(null);
      d.querySelector(".td-ok").onclick = submit;
      // Esc closes it wherever the focus is (Safari leaves the focus on the page after a button click)
      const onKey = (e) => { if (e.key === "Escape" && d.isConnected) { e.preventDefault(); done(null); } };
      document.addEventListener("keydown", onKey, true);
      const done0 = done; done = (v) => { document.removeEventListener("keydown", onKey, true); done0(v); };
      d.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        else if (e.key === "Enter" && e.target.tagName === "INPUT" && !/radio|checkbox|file/.test(e.target.type)) { e.preventDefault(); submit(); }
      });
      TOOLS.open = d;
    });
  };

  /** A window showing the progress of a long task, with Cancel. */
  TOOLS.progress = (title) => {
    const d = el(`<div class="dlg tool-dlg" role="dialog" aria-modal="true" aria-live="polite"><div class="box">
      <h2>${esc(title)}</h2><p class="small pg-text"></p><div class="pg-bar"><div class="pg-fill"></div></div>
      <div class="actions"><button class="pg-cancel">${esc(t("Cancel"))}</button></div></div></div>`);
    document.body.appendChild(d);
    let base = 0, span = 1, cb = null;
    const fill = d.querySelector(".pg-fill");
    const draw = (v) => { fill.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + "%"; };
    d.querySelector(".pg-cancel").onclick = () => { if (cb) cb(); d.remove(); };
    return {
      set(text, b, sp) { d.querySelector(".pg-text").textContent = text; base = b; span = sp; draw(b); },
      step(p) { draw(base + span * p); },
      onCancel(f) { cb = f; },
      close() { d.remove(); },
    };
  };

  /* ---------------------------------------------------------------- split or extract pages */
  async function split() {
    const n = S.doc.pages.length;
    const v = await TOOLS.ask("splitDlg", t("Split or extract pages"), `
      <label class="opt"><input type="radio" name="mode" value="extract" checked> <span>${esc(t("Extract pages into one new PDF"))}</span></label>
      <label class="opt"><input type="radio" name="mode" value="ranges"> <span>${esc(t("One PDF per range"))}</span></label>
      <label class="opt"><input type="radio" name="mode" value="each"> <span>${esc(t("One PDF per page"))}</span></label>
      <label class="field">${esc(t("Pages"))} <input name="pages" type="text" value="1-${n}" inputmode="numeric" autocomplete="off"></label>
      <p class="small muted">${esc(t("This PDF has {n} pages. For example: 1-3, 5, 8-").replace("{n}", n))}</p>`,
      t("Split"), (v) => (v.mode === "each" || TOOLS.ranges(v.pages, n) ? null : t("Check the pages: numbers from 1 to {n}, like 1-3, 5").replace("{n}", n)));
    if (!v) return;
    let parts;
    if (v.mode === "each") parts = [...Array(n).keys()].map((i) => [i]);
    else { const r = TOOLS.ranges(v.pages, n); parts = v.mode === "extract" ? [[...new Set(r.flat())]] : r; }
    await closeEditor(true);
    await busy(async () => {
      const files = await call("extract", parts);
      const names = parts.map((p) => `${base()} ${rangeLabel(p)}.pdf`);
      if (files.length === 1) await TOOLS.saveOut(files[0], names[0]);
      else await TOOLS.saveOut(await call("zip", files.map((b, i) => ({ name: names[i], bytes: b }))), `${base()}.zip`);
    });
  }

  /* ---------------------------------------------------------------- convert */
  async function convert() {
    const v = await TOOLS.ask("convertDlg", t("Convert"), `
      <label class="opt"><input type="radio" name="to" value="docx" checked> <span><b>Word</b> (.docx) – ${esc(t("the text, to edit it in Word; the layout is not kept"))}</span></label>
      <label class="opt"><input type="radio" name="to" value="png"> <span><b>${esc(t("Pictures"))}</b> (PNG) – ${esc(t("one picture per page"))}</span></label>
      <label class="opt"><input type="radio" name="to" value="jpg"> <span><b>${esc(t("Pictures"))}</b> (JPEG) – ${esc(t("smaller files"))}</span></label>
      <label class="opt"><input type="radio" name="to" value="txt"> <span><b>${esc(t("Text"))}</b> (.txt)</span></label>
      <label class="field">${esc(t("Picture quality"))} <select name="dpi"><option value="150">${esc(t("Screen (150 dpi)"))}</option><option value="300">${esc(t("Print (300 dpi)"))}</option></select></label>
      <p class="small muted">${esc(t("To turn a Word, Excel or PowerPoint file into a PDF, use File › Save as or Export as PDF in that program."))}</p>`, t("Convert"));
    if (!v) return;
    await closeEditor(true);
    await busy(async () => {
      if (v.to === "docx") return TOOLS.saveOut(await call("toDocx"), base() + ".docx");
      if (v.to === "txt") return TOOLS.saveOut(new TextEncoder().encode(await call("toText")), base() + ".txt");
      const imgs = await call("toImages", v.to, +v.dpi);
      if (imgs.length === 1) return TOOLS.saveOut(imgs[0].bytes, `${base()}.${v.to}`);
      const w = String(imgs.length).length;
      return TOOLS.saveOut(await call("zip", imgs.map((im, i) => ({ name: `${base()}-${String(i + 1).padStart(w, "0")}.${v.to}`, bytes: im.bytes }))), `${base()}-${v.to}.zip`);
    });
  }

  /* ---------------------------------------------------------------- protect with a password */
  async function protect() {
    const v = await TOOLS.ask("protectDlg", t("Protect with a password"), `
      <label class="field">${esc(t("Password"))} <input name="pw" type="password" autocomplete="new-password"></label>
      <label class="field">${esc(t("Type it again"))} <input name="pw2" type="password" autocomplete="new-password"></label>
      <label class="check"><input type="checkbox" name="print" checked> <span>${esc(t("Allow printing"))}</span></label>
      <label class="check"><input type="checkbox" name="copy"> <span>${esc(t("Allow copying the text"))}</span></label>
      <p class="small muted">${esc(t("Keep the password safe: without it nobody can open the PDF. The protected copy is a new file; the PDF open here is not changed."))}</p>`,
      t("Protect"), (v) => (v.pw.length < 4 ? t("Choose a password of at least 4 characters") : v.pw.includes(",") ? t("The password cannot contain a comma") : v.pw !== v.pw2 ? t("The two passwords are different") : null));
    if (!v) return;
    await closeEditor(true);
    await busy(async () => TOOLS.saveOut(await call("protect", v.pw, v.print, v.copy), base() + ".pdf"));
  }

  /* ---------------------------------------------------------------- page numbers */
  async function numbers() {
    const n = S.doc.pages.length;
    const v = await TOOLS.ask("numbersDlg", t("Page numbers"), `
      <label class="field">${esc(t("Where"))} <select name="position"><option value="bottom-center">${esc(t("Bottom, centred"))}</option><option value="bottom-right">${esc(t("Bottom right"))}</option><option value="bottom-left">${esc(t("Bottom left"))}</option><option value="top-right">${esc(t("Top right"))}</option></select></label>
      <label class="field">${esc(t("Style"))} <select name="format"><option value="{n}">1, 2, 3…</option><option value="{n} / {total}">1 / ${n}</option><option value="page">${esc(t("Page {n} of {total}").replace("{n}", 1).replace("{total}", n))}</option></select></label>
      <label class="field">${esc(t("First number"))} <input name="start" type="number" value="1" min="0" step="1"></label>
      <label class="check"><input type="checkbox" name="skipFirst"> <span>${esc(t("Not on the first page (cover)"))}</span></label>`, t("Add numbers"));
    if (!v) return;
    const format = v.format === "page" ? t("Page {n} of {total}") : v.format;
    await closeEditor(true);
    await busy(async () => {
      applyInfo(await call("pageNumbers", { format, position: v.position, start: Number.isFinite(+v.start) ? +v.start : 1, skipFirst: v.skipFirst }));
      toast(t("Page numbers added. You can undo it."));
    });
  }

  /* ---------------------------------------------------------------- watermark */
  async function watermark() {
    const v = await TOOLS.ask("watermarkDlg", t("Watermark"), `
      <label class="field">${esc(t("Text"))} <input name="text" type="text" maxlength="60" value="${esc(t("CONFIDENTIAL"))}"></label>
      <label class="field">${esc(t("Strength"))} <select name="opacity"><option value="0.12">${esc(t("Light"))}</option><option value="0.2" selected>${esc(t("Medium"))}</option><option value="0.35">${esc(t("Strong"))}</option></select></label>
      <label class="field">${esc(t("Colour"))} <select name="color"><option value="#c0392b">${esc(t("Red"))}</option><option value="#555555">${esc(t("Grey"))}</option><option value="#1f4e9c">${esc(t("Blue"))}</option></select></label>`,
      t("Add watermark"), (v) => (v.text.trim() ? null : t("Type the text of the watermark")));
    if (!v) return;
    await closeEditor(true);
    await busy(async () => {
      applyInfo(await call("watermark", v.text, { opacity: +v.opacity, color: v.color }));
      toast(t("Watermark added. You can undo it."));
    });
  }

  /* ---------------------------------------------------------------- a PDF from pictures */
  /** JPEG and PNG are used as they are; other pictures (HEIC, WebP, AVIF…) and photos taken sideways
   *  are drawn by the browser first, so they come out the right way up. */
  async function prepare(f) {
    const raw = new Uint8Array(await f.arrayBuffer());
    const png = raw[0] === 0x89 && raw[1] === 0x50;
    if (png) return raw;
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
      return new Uint8Array(await blob.arrayBuffer());
    } catch (e) { return raw; }                    // the engine names the file if it cannot read it
  }
  TOOLS.fromImages = async (files) => {
    files = [...files].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif|avif)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) return toast(t("Please choose pictures (JPEG, PNG…)"), true);
    if (S.dirty && S.doc && !(await modal({ title: t("Open another PDF?"), text: t("Your edits to “{name}” have not been saved. They will be lost.").replace("{name}", S.doc.name), ok: t("Open anyway") }))) return;
    await closeEditor(false);
    await busy(async () => {
      const list = [];
      for (const f of files) list.push({ name: f.name, bytes: await prepare(f) });
      const info = await call("fromImages", list, { name: base(files[0].name) + ".pdf" });
      window.PDFE_STATS && PDFE_STATS.event("pdf_created");
      $("#resume").hidden = true;
      loadDoc(info, true);
      if (window.FILES) FILES.opened(null);
      S.dirty = true;
      if (window.FILES) FILES.afterChange();
      toast(files.length > 1 ? t("PDF made from {n} pictures. Save it to keep it.").replace("{n}", files.length) : t("PDF made from the picture. Save it to keep it."));
    });
  };

  /* ---------------------------------------------------------------- the menu */
  const I = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ITEMS = [
    ["sign", "Sign", "Draw, type or upload your signature", I('<path d="M3 17c3-6 5-6 6-3s2 3 4-1 3-4 4 0"/><path d="M3 21h18"/>')],
    ["redact", "Redact", "Remove private text and pictures for good", I('<rect x="3" y="6" width="18" height="5" rx="1" fill="currentColor"/><path d="M3 15h10M3 19h14"/>')],
    ["ocr", "Make searchable (OCR)", "Recognise the text of scanned pages", I('<path d="M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3"/><path d="M8 9h8M8 12h8M8 15h5"/>')],
    ["split", "Split or extract pages", "Separate PDFs from some pages", I('<rect x="4" y="3" width="7" height="9" rx="1"/><rect x="13" y="12" width="7" height="9" rx="1"/><path d="m14 4 6 6M20 4l-6 6"/>')],
    ["convert", "Convert", "To Word, text or pictures", I('<path d="M4 7h13l-3-3M20 17H7l3 3"/>')],
    ["protect", "Protect with a password", "Only people with the password can open it", I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>')],
    ["numbers", "Page numbers", "Number every page", I('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M10 17h4M12 14v6"/>')],
    ["watermark", "Watermark", "A word across every page", I('<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>')],
    ["reduce", "Reduce file size", "Compress photos and scans", I('<path d="M8 3v6H3M16 3v6h5M8 21v-6H3M16 21v-6h5"/>')],
  ];
  const RUN = {
    sign: () => window.SIGN && SIGN.open(), redact: () => window.REDACT && REDACT.start(), ocr: () => window.OCR && OCR.open(),
    split, convert, protect, numbers, watermark, reduce: () => window.REDUCE && REDUCE.open(),
  };
  TOOLS.run = (k) => { if (S.doc && RUN[k]) { window.PDFE_STATS && PDFE_STATS.event("tool_used", { tool: k }); return RUN[k](); } };

  function menu() {
    const find = document.getElementById("btnFind");
    if (!find || document.getElementById("btnTools")) return;
    const btn = el(`<button id="btnTools" class="needs-doc" title="${esc(t("Tools: sign, redact, OCR, split, convert…"))}" aria-haspopup="menu" aria-expanded="false" disabled>${I('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>')}<span>${esc(t("Tools"))}</span></button>`);
    find.before(btn);
    const m = el(`<div id="toolsMenu" class="tools-menu" role="menu" hidden></div>`);
    for (const [k, title, sub, icon] of ITEMS) {
      const b = el(`<button role="menuitem" data-k="${k}">${icon}<span><b>${esc(t(title))}</b><small>${esc(t(sub))}</small></span></button>`);
      b.onclick = () => { close(); TOOLS.run(k); };
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const close = () => { m.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    const open = () => {
      const r = btn.getBoundingClientRect(), rtl = document.documentElement.dir === "rtl";
      m.hidden = false;
      const w = m.offsetWidth;
      const x = rtl ? Math.max(8, r.right - w) : Math.min(r.left, innerWidth - w - 8);
      Object.assign(m.style, { top: r.bottom + 6 + "px", left: Math.max(8, x) + "px" });
      btn.setAttribute("aria-expanded", "true");
      m.querySelector("button").focus();
    };
    btn.onclick = (e) => { e.stopPropagation(); m.hidden ? open() : close(); };
    document.addEventListener("pointerdown", (e) => { if (!m.hidden && !m.contains(e.target) && !btn.contains(e.target)) close(); }, true);
    m.addEventListener("keydown", (e) => {
      const items = [...m.querySelectorAll("button")], i = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    TOOLS.menu = { open, close, el: m };
  }

  function startScreen() {
    const drop = document.querySelector("#empty .drop");
    if (!drop || document.getElementById("btnFromImages")) return;
    const open2 = document.getElementById("btnOpen2");
    const p = el(`<p class="from-images"><button id="btnFromImages" class="link">${esc(t("Create a PDF from pictures"))}</button><input id="imagesInput" type="file" accept="image/*" multiple hidden></p>`);
    (open2 ? open2.closest("p") : drop.querySelector("h2") || drop.firstChild).after(p);
    const input = p.querySelector("#imagesInput");
    p.querySelector("#btnFromImages").onclick = () => input.click();
    input.onchange = () => { const f = [...input.files]; input.value = ""; TOOLS.fromImages(f); };
  }

  function start() { menu(); startScreen(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
