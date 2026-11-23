/* PDF Editor - Word (.docx, .dotx) and LibreOffice (.odt, .ott) documents, in the same editor as PDFs.
 * The word processor is EdenText (AGPL, by Steffen Becker), served unmodified from ./edentext/ and shown
 * in a frame in its embed mode, in place of the PDF pages: it keeps nothing itself and the editor owns the
 * file, as for a PDF — the same Open, drop, Recent files, Save into the opened file (Chrome, Edge) or a
 * download, Download copy (Word, LibreOffice or PDF), unsaved copy shown in Recent files, language menu.
 * The frame is created the first time a document is opened, so PDF users load none of it.
 * EdenText's AI assistant and dictation are off (they would send the text or the voice to another
 * service), and the site's headers allow it no connection to another site. Nothing is uploaded. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const tf = (s, v) => t(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
  const $ = (s) => document.querySelector(s);
  const STORE = window.DOCSTORE;
  const HELPER = new URL("edentext/embed.js", document.currentScript.src).href;
  const FS = typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";
  const TYPES = {
    docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx", label: "Word document" },
    odt: { mime: "application/vnd.oasis.opendocument.text", ext: ".odt", label: "LibreOffice document" },
    pdf: { mime: "application/pdf", ext: ".pdf", label: "PDF document" },
  };
  // the site's languages that EdenText 0.15.0 speaks; the others get its English (Dutch, Hebrew, and Arabic, which comes after 0.15.0)
  const LOCALES = { en: "en", fr: "fr", es: "es", pt: "pt", de: "de", it: "it", pl: "pl", ja: "ja", zh: "zh-Hans" };
  const COPY_EVERY = 15000;

  const D = { open: false, name: "", fmt: "docx", handle: null, edDirty: false, hostDirty: false, copyHash: "" };
  const dirty = () => D.open && (D.edDirty || D.hostDirty);
  const base = (n) => n.replace(/\.(docx|dotx|odt|ott)$/i, "");
  const kindOf = (name) => {
    const m = /\.(docx|dotx|odt|ott)$/i.exec(name || "");
    if (!m) return null;
    const e = m[1].toLowerCase();
    return { fmt: e === "docx" || e === "dotx" ? "docx" : "odt", template: e === "dotx" || e === "ott" };
  };
  // counts only that something happened, and for documents their kind (docx, odt…) or a download's format
  const stats = (e, type) => window.PDFE_STATS && PDFE_STATS.event(e, type ? { type } : {});
  const ext = (name) => ((/\.(docx|dotx|odt|ott)$/i.exec(name || "") || [])[1] || "").toLowerCase();
  const say = (m, err) => (typeof toast === "function" ? toast(m, err) : console.log(m));

  /* ---------------------------------------------------------------- the word processor (made when first needed) */
  let framePromise = null, current = null;
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  function frame() {
    if (framePromise) return framePromise;
    const wrap = $("#docFrame");
    framePromise = import(HELPER).then(({ EdenTextFrame }) => {
      const ed = (current = new EdenTextFrame(wrap, { locale: LOCALES[(window.I18N && I18N.lang) || "en"] || "en", theme: "auto", accent: "#e5322d", ai: false, dictation: false }));
      ed.on("dirty", (m) => { D.edDirty = !!m.dirty; if (dirty()) keepCopySoon(); mark(); });
      ed.on("saveRequest", () => run(save));
      ed.on("warning", (m) => { if (m.warnings && m.warnings.length) say(t("Some parts of this document could not be kept:") + " " + m.warnings.join(" · "), true); });
      // a word processor that does not start within 40 s is replaced once
      return Promise.race([ed.ready, later(40000, "late")]).then((v) => {
        if (v !== "late") return v;
        resetFrame();
        return frame();
      });
    }).catch((e) => {
      framePromise = null;
      wrap.textContent = "";
      throw new Error(tf("Word and LibreOffice documents cannot be opened right now: {m}", { m: e.message }));
    });
    return framePromise;
  }
  /** Throw the word processor away; the next frame() starts a new one. */
  function resetFrame() {
    try { if (current) current.destroy(); } catch (e) {}
    current = null; framePromise = null;
    const w = $("#docFrame"); for (const f of w.querySelectorAll("iframe")) f.remove();
  }
  /** Is the word processor showing a dialog (a password prompt…)? Then it waits for the person, not stuck. */
  function frameAsks() {
    try {
      const d = $("#docFrame iframe").contentDocument;
      // only a dialog that is on screen counts (the word processor keeps many hidden ones in its page)
      return [...d.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
        .some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.ownerDocument.defaultView.getComputedStyle(e).visibility !== "hidden"; });
    } catch (e) { return false; }
  }
  /** Open a file in the word processor. Rarely (seen in Firefox, over the network) it never answers the first
   *  time: after 15 s without an answer and without a dialog on screen, a new word processor is started and the
   *  file is sent again. Resolves like EdenTextFrame.load (false: the person gave up at a password). */
  async function loadFile(file) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ed = await frame();
      const job = ed.load(file, file.name);
      for (;;) {
        const r = await Promise.race([job, later(attempt ? 45000 : 15000, "late")]);
        if (r !== "late") return r;
        if (!frameAsks()) break;                            // stuck: try again with a new one
      }
      resetFrame();
      stats("doc_retry");
    }
    stats("doc_failed");
    throw new Error(t("The document could not be opened. Reload the page and try again."));
  }
  async function run(fn) {
    document.body.classList.add("busy");
    try { return await fn(); }
    catch (e) { if (e && e.name === "AbortError") return; console.error(e); say(tf("Something went wrong: {m}", { m: (e && e.message) || e }), true); }
    finally { document.body.classList.remove("busy"); }
  }
  function ask(title, text, buttons) {
    return new Promise((done) => {
      const d = document.createElement("div");
      d.className = "dlg"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
      d.innerHTML = '<div class="box"><h2></h2><p></p><div class="actions"></div></div>';
      d.querySelector("h2").textContent = title;
      d.querySelector("p").textContent = text;
      const finish = (v) => { d.remove(); done(v); };
      for (const [v, label, primary] of buttons) {
        const b = document.createElement("button");
        b.textContent = label; if (primary) b.className = "primary";
        b.onclick = () => finish(v);
        d.querySelector(".actions").appendChild(b);
      }
      d.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } });
      document.body.appendChild(d);
      d.querySelector(".primary").focus();
    });
  }

  /* ---------------------------------------------------------------- what the toolbar shows */
  function mark() {
    document.body.classList.toggle("doc-mode", D.open);
    if (!D.open) return;
    const st = $("#saveState");
    if (st) {
      st.hidden = false;
      st.textContent = dirty() ? t("Not saved") : D.handle ? t("Saved") : "";
      st.classList.toggle("dirty", dirty());
    }
    for (const b of document.querySelectorAll(".doc-ok")) b.disabled = false;
    const sb = $("#btnSave");
    if (sb) {
      const sp = sb.querySelector("span"), label = D.handle ? t("Save (overwrites)") : t("Save");
      if (sp && sp.textContent !== label) sp.textContent = label;
      sb.title = D.handle ? tf("Save into “{name}” (⌘S / Ctrl+S)", { name: D.name }) : t("Save the document (⌘S / Ctrl+S)");
    }
    const db = $("#btnDownload");
    if (db) db.title = t("Download a copy: Word, LibreOffice or PDF");
    $("#docName").textContent = D.name;
    $("#docName").title = D.name;
    document.title = (dirty() ? "• " : "") + D.name + " – " + "Quicktou.ch";
  }

  /* ---------------------------------------------------------------- open, new, close */
  /** Before replacing or closing the document: true to go on (saved, or the changes given up). */
  async function leave() {
    if (!dirty()) return true;
    const v = await ask(t("Save your changes?"), tf("“{name}” has changes that are not saved.", { name: D.name }),
      [[null, t("Cancel")], ["discard", t("Don't save")], ["save", t("Save"), true]]);
    if (v === "save") return await save();
    return v === "discard";
  }
  /** Show the document in place of the PDF pages. o: {dirty, name, quiet} */
  async function openDoc(file, handle, o = {}) {
    const k = kindOf(file.name);
    if (!k) return false;
    if (!o.skipLeave && !(await leave())) return false;
    if (window.PDFDOC && PDFDOC.isOpen() && !(await PDFDOC.close())) return false;   // one file at a time
    const was = D.open;
    document.body.classList.add("doc-mode", "doc-loading");
    let ed;
    try { ed = await frame(); }
    catch (e) { document.body.classList.remove("doc-loading"); if (!was) document.body.classList.remove("doc-mode"); throw e; }
    document.body.classList.remove("doc-loading");
    const ok = await loadFile(file);
    ed = await frame();                                     // the word processor that opened it
    if (!ok) { if (!was) document.body.classList.remove("doc-mode"); return false; }     // gave up at a password
    Object.assign(D, { open: true, name: o.name || file.name, fmt: k.fmt, handle: k.template ? null : handle || null,
                       edDirty: false, hostDirty: !!o.dirty, copyHash: "" });
    await ed.configure({ name: base(D.name) });
    await STORE.del("keep", "recovery");
    if (window.FILES) { FILES.setDocResume(null); if (D.handle) FILES.remember(D.handle, D.name); }
    if (D.hostDirty) keepCopySoon();
    mark();
    if (!o.quiet) stats("doc_opened", ext(file.name));
    return true;
  }
  async function newDoc() {
    if (!(await leave())) return;
    if (window.PDFDOC && PDFDOC.isOpen() && !(await PDFDOC.close())) return;
    document.body.classList.add("doc-mode", "doc-loading");
    let ed;
    try { ed = await frame(); } catch (e) { document.body.classList.remove("doc-mode"); throw e; }
    finally { document.body.classList.remove("doc-loading"); }
    const name = t("Untitled") + ".docx";
    await ed.newDocument(base(name));
    Object.assign(D, { open: true, name, fmt: "docx", handle: null, edDirty: false, hostDirty: false, copyHash: "" });
    await STORE.del("keep", "recovery");
    if (window.FILES) FILES.setDocResume(null);
    mark();
    stats("doc_created");
  }
  /** Close the document (after asking about unsaved changes unless force). True when closed. */
  async function closeDoc(force) {
    if (!D.open) return true;
    if (!force && !(await leave())) return false;
    const ed = await frame();
    await ed.newDocument();
    Object.assign(D, { open: false, name: "", handle: null, edDirty: false, hostDirty: false, copyHash: "" });
    clearTimeout(copyTimer);
    await STORE.del("keep", "recovery");
    document.body.classList.remove("doc-mode");
    $("#docName").textContent = "Quicktou.ch"; $("#docName").title = "";
    document.title = t("Quicktou.ch – edit PDF, Word and LibreOffice files");
    if (window.FILES) FILES.closed();
    if (typeof updateButtons === "function") updateButtons();
    return true;
  }

  /* ---------------------------------------------------------------- save, download */
  async function writeInto(handle, file) {
    if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted" && (await handle.requestPermission({ mode: "readwrite" })) !== "granted")
      throw Object.assign(new Error(t("Permission to write into the file was not given.")), { name: "NotAllowedError" });
    const w = await handle.createWritable();
    try { await w.write(file); await w.close(); } catch (e) { try { await w.abort(); } catch (x) {} throw e; }
  }
  function downloadFile(file, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  async function saved() {
    const ed = await frame();
    await ed.markSaved();
    D.edDirty = false; D.hostDirty = false; D.copyHash = "";
    await STORE.del("keep", "recovery");
    mark();
  }
  /** Save: into the opened file; else a new file (Chrome, Edge); else a download. True once stored. */
  async function save() {
    if (!D.open) return false;
    const ed = await frame();
    if (D.handle) {
      try {
        await writeInto(D.handle, await ed.export(D.fmt));
        await saved();
        say(tf("Saved in “{name}”", { name: D.name }));
        stats("doc_saved");
        return true;
      } catch (e) {
        if (e && e.name === "NotAllowedError") { say(e.message, true); return false; }
        if (!(e && e.name === "NotFoundError")) throw e;
        D.handle = null;                                    // the file was moved or deleted: save a new one
      }
    }
    if (FS) return saveAs();
    const name = base(D.name) + TYPES[D.fmt].ext;
    downloadFile(await ed.export(D.fmt), name);
    await saved();
    say(tf("Downloaded “{name}”", { name }));
    stats("doc_downloaded", D.fmt);
    return true;
  }
  async function saveAs() {
    const ed = await frame();
    const order = D.fmt === "odt" ? ["odt", "docx"] : ["docx", "odt"];
    let h;
    try {
      h = await window.showSaveFilePicker({ suggestedName: base(D.name) + TYPES[order[0]].ext,
        types: order.map((f) => ({ description: t(TYPES[f].label), accept: { [TYPES[f].mime]: [TYPES[f].ext] } })) });
    } catch (e) { return false; }
    const k = kindOf(h.name) || { fmt: order[0] };
    await writeInto(h, await ed.export(k.fmt));
    Object.assign(D, { handle: h, name: h.name, fmt: k.fmt });
    await ed.configure({ name: base(D.name) });
    if (window.FILES) FILES.remember(h, h.name);
    await saved();
    say(tf("Saved in “{name}”", { name: D.name }));
    stats("doc_saved");
    return true;
  }
  async function downloadAs(fmt) {
    const ed = await frame();
    const name = base(D.name) + TYPES[fmt].ext;
    downloadFile(await ed.export(fmt), name);
    say(tf("Downloaded “{name}”", { name }));
    stats("doc_downloaded", fmt);
  }
  /* the Download copy menu: Word, LibreOffice or PDF */
  let menu = null;
  function downloadMenu() {
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "docDownloadMenu"; menu.className = "tools-menu"; menu.setAttribute("role", "menu"); menu.hidden = true;
      for (const [fmt, label, ext] of [["docx", t("Word document"), ".docx"], ["odt", t("LibreOffice document"), ".odt"], ["pdf", "PDF", ".pdf"]]) {
        const b = document.createElement("button");
        b.setAttribute("role", "menuitem"); b.dataset.fmt = fmt;
        b.innerHTML = '<span class="dm-name"></span><span class="dm-ext" data-noi18n></span>';
        b.querySelector(".dm-name").textContent = label;
        b.querySelector(".dm-ext").textContent = ext;
        b.onclick = () => { closeMenu(); run(() => downloadAs(fmt)); };
        menu.appendChild(b);
      }
      menu.addEventListener("keydown", (e) => {
        const bs = [...menu.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
        if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      });
      document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest("#btnDownload, #btnMore")) closeMenu(); }, true);
      document.body.appendChild(menu);
    }
    if (!menu.hidden) return closeMenu();
    const btn = $("#btnDownload");
    const anchor = btn && btn.offsetParent ? btn : ($("#btnMore") || btn);      // in the "⋯" menu on a phone
    menu.hidden = false;
    const r = anchor.getBoundingClientRect(), w = menu.offsetWidth, rtl = document.documentElement.dir === "rtl";
    const x = rtl ? r.right - w : r.left;
    Object.assign(menu.style, { top: r.bottom + 6 + "px", left: Math.min(Math.max(8, x), innerWidth - w - 8) + "px" });
    btn.setAttribute("aria-expanded", "true");
    menu.querySelector("button").focus();
  }
  function closeMenu() { if (menu && !menu.hidden) { menu.hidden = true; $("#btnDownload").setAttribute("aria-expanded", "false"); } }

  /* ---------------------------------------------------------------- the unsaved copy, shown in Recent files */
  let copyTimer = 0, copyBusy = false;
  function keepCopySoon(ms = 2500) { clearTimeout(copyTimer); copyTimer = setTimeout(keepCopy, ms); }
  async function keepCopy() {
    clearTimeout(copyTimer);
    if (!dirty() || copyBusy) return;
    copyBusy = true;
    try {
      const ed = await frame();
      const file = await ed.export(D.fmt);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (b) => b.toString(16).padStart(2, "0")).join("");
      if (dirty() && hash !== D.copyHash) {
        await STORE.put("keep", { id: "recovery", file, name: D.name, handle: D.handle, time: Date.now() });
        D.copyHash = hash;
      }
    } catch (e) { /* storage full or unavailable: no copy */ }
    finally { copyBusy = false; if (dirty()) copyTimer = setTimeout(keepCopy, COPY_EVERY); }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty()) keepCopy(); });
  let leaving = false;
  addEventListener("beforeunload", (e) => { if (dirty() && !leaving) { keepCopy(); e.preventDefault(); e.returnValue = ""; } });
  async function offerCopy() {
    const rec = await STORE.get("keep", "recovery");
    if (!window.FILES || !FILES.setDocResume) return;
    FILES.setDocResume(rec && !D.open ? {
      name: rec.name, time: rec.time,
      resume: () => run(() => openDoc(new File([rec.file], rec.name, { type: rec.file.type }), rec.handle, { dirty: true, skipLeave: true, quiet: true, name: rec.name })),
      discard: async () => { await STORE.del("keep", "recovery"); FILES.setDocResume(null); },
    } : null);
  }

  /* ---------------------------------------------------------------- language: the document comes back as it was */
  async function keepForReload() {
    if (!D.open) return;
    const ed = await frame();
    await STORE.put("keep", { id: "reopen", file: await ed.export(D.fmt), name: D.name, handle: D.handle, dirty: dirty(), time: Date.now() });
    leaving = true;
  }

  /* ---------------------------------------------------------------- keys outside the frame (inside it, EdenText sends saveRequest) */
  document.addEventListener("keydown", (e) => {
    if (!D.open || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); e.stopImmediatePropagation(); run(e.shiftKey && FS ? saveAs : save); }
  }, true);

  window.DOCS = {
    isOpen: () => D.open, isDoc: (n) => !!kindOf(n), state: D,
    open: (file, handle) => run(() => openDoc(file, handle)), openDoc, newDoc: () => run(newDoc), close: closeDoc, leave,
    save: () => run(save), saveAs, download: downloadMenu, downloadAs, mark, keepCopy, keepForReload,
  };

  /* ---------------------------------------------------------------- start */
  async function start() {
    const nb = $("#btnNewDoc");
    if (nb) nb.onclick = () => DOCS.newDoc();
    const dc = $("#btnDocClose");
    if (dc) dc.onclick = () => run(() => closeDoc(false));
    if (window.I18N) await I18N.ready;
    // back from a language change, or a PDF's text sent here by Convert › Edit as a document
    const again = await STORE.take("keep", "reopen");
    const hand = !again && location.hash === "#doc" ? await STORE.take("keep", "handoff") : null;
    if (location.hash === "#doc") history.replaceState(null, "", location.pathname + location.search);
    if (again) await run(() => openDoc(new File([again.file], again.name, { type: again.file.type }), again.handle, { dirty: again.dirty, skipLeave: true, quiet: true, name: again.name }));
    else if (hand) await run(() => openDoc(hand.file, hand.handle, { skipLeave: true }));
    if (!D.open) offerCopy();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
