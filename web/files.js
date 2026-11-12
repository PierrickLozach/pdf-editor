/* PDF Editor - working with files on the computer (uses the globals of app.js).
 *  - Chrome and Edge (File System Access API): a PDF opened with Open, dropped on the page or
 *    picked from "Recent files" is saved straight back into the same file by Save (⌘S).
 *    "Recent files" remembers the files themselves (handles), never copies of them.
 *  - Other browsers: Save downloads the edited copy, as before.
 *  - The size limit of a PDF, shown on the start screen and explained when a file is larger. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const MAX = 250 * 1024 * 1024;            // largest PDF tested to open, edit and save in every browser
  const KEEP = 10, SHOW = 5;
  const CUR = "pdfe.currentRecent";          // which recent file is open (to match the unsaved copy with it)
  const F = (window.FILES = { handle: null, maxBytes: MAX, supported: typeof window.showOpenFilePicker === "function" });
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };
  const lang = () => document.documentElement.lang || "en";
  F.size = (b) => {
    const big = b >= 1048576, v = big ? b / 1048576 : Math.max(1, Math.round(b / 1024));
    return `${v.toLocaleString(lang(), { maximumFractionDigits: big && v < 10 ? 1 : 0 })} ${t(big ? "MB" : "KB")}`;
  };
  const when = (ms) => new Date(ms).toLocaleString(lang(), { dateStyle: "medium", timeStyle: "short" });

  /* ---------------------------------------------------------------- recent files (handles) */
  let dbp = null;
  function db() {
    return (dbp = dbp || new Promise((res, rej) => {
      const r = indexedDB.open("pdf-editor-files", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("recent", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }
  async function store(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const x = d.transaction("recent", mode), st = x.objectStore("recent");
      let out;
      Promise.resolve(fn(st)).then((v) => (out = v), rej);
      x.oncomplete = () => res(out);
      x.onerror = () => rej(x.error);
    });
  }
  const all = (st) => new Promise((r) => { const q = st.getAll(); q.onsuccess = () => r(q.result || []); q.onerror = () => r([]); });
  async function remember(handle, name) {
    if (!handle || !F.supported) return;
    try {
      const list = await store("readonly", all);
      let same = null;
      for (const x of list) { try { if (await x.handle.isSameEntry(handle)) { same = x; break; } } catch (e) {} }
      const id = same ? same.id : crypto.randomUUID();
      try { localStorage.setItem(CUR, id); } catch (e) {}
      await store("readwrite", (st) => {
        st.put({ id, name, handle, time: Date.now() });
        list.filter((x) => x.id !== id).sort((a, b) => b.time - a.time).slice(KEEP - 1).forEach((x) => st.delete(x.id));
      });
    } catch (e) { /* storage unavailable (private mode): no recent list */ }
  }
  /* The start screen lists the recent files, at most 5. When an unsaved copy of the last PDF is still in
   * the browser (the tab was closed or the browser quit), it is shown on that file's line — "Unsaved
   * changes" with Resume — instead of in a box of its own; a PDF without a recent entry (Firefox,
   * Safari, a PDF made from pictures) gets one line for it. */
  let resumeRec = null;
  F.setResume = (rec) => { resumeRec = rec && rec.unsaved ? rec : null; renderRecent(); };
  const short = (ms) => {
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(lang(), { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString(lang(), d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { dateStyle: "medium" });
  };
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  async function renderRecent() {
    let box = document.getElementById("recentFiles");
    if (!box) {
      box = el(`<section id="recentFiles" aria-labelledby="recentTitle" hidden>
        <h2 id="recentTitle">${t("Recent files")}</h2><ul></ul></section>`);
      const slot = document.getElementById("recentSlot");               // under the main button
      if (slot) slot.appendChild(box); else document.querySelector("#empty .drop").prepend(box);
    }
    let list = F.supported ? (await store("readonly", all).catch(() => [])).sort((a, b) => b.time - a.time) : [];
    let cur = null; try { cur = localStorage.getItem(CUR); } catch (e) {}
    const rec = resumeRec && !(window.S && S.doc) ? resumeRec : null;
    // the unsaved copy belongs to the recent file that was open, if it is still in the list
    let host = rec ? list.find((x) => x.id === cur && x.name === rec.name) : null;
    const ul = box.querySelector("ul");
    ul.textContent = "";
    const row = (name, time, unsaved) => {
      const li = el(`<li${unsaved ? ' class="rf-unsaved"' : ""}><button class="rf-open">${ICON}<span class="rf-name"></span>${unsaved ? `<span class="rf-badge">${t("Unsaved changes")}</span>` : ""}<span class="rf-when"></span></button><button class="rf-del icon">✕</button></li>`);
      li.querySelector(".rf-name").textContent = name;
      li.querySelector(".rf-name").title = name;
      li.querySelector(".rf-when").textContent = short(time);
      ul.appendChild(li);
      return li;
    };
    if (rec) {
      const li = row(rec.name, Math.max(rec.time || 0, host ? host.time : 0), true);
      li.querySelector(".rf-open").title = t("Resume editing");
      li.querySelector(".rf-del").title = t("Discard the unsaved changes");
      li.querySelector(".rf-open").onclick = () => resume(host);
      li.querySelector(".rf-del").onclick = async () => {
        if (!(await modal({ title: t("Discard the unsaved changes?"), text: t("The changes to “{name}” that were not saved are deleted. The file itself is not changed.").replace("{name}", rec.name), ok: t("Discard"), danger: true }))) return;
        await call("discard"); resumeRec = null; renderRecent();
      };
    }
    for (const x of list.filter((x) => x !== host).slice(0, rec ? SHOW - 1 : SHOW)) {
      const li = row(x.name, x.time, false);
      li.querySelector(".rf-del").title = t("Remove from this list");
      li.querySelector(".rf-open").onclick = () => openRecent(x);
      li.querySelector(".rf-del").onclick = async () => { await store("readwrite", (st) => st.delete(x.id)); renderRecent(); };
    }
    box.hidden = !ul.children.length;
    const old = document.getElementById("resume"); if (old) old.hidden = true;     // the separate box is not used any more
  }
  /** Reopen the unsaved copy; when it belongs to a recent file, Save goes back into that file. */
  async function resume(host) {
    await busy(async () => {
      const info = await call("restore");
      resumeRec = null;
      loadDoc(info, true);
      S.dirty = true;
      F.handle = host ? host.handle : null;
      mark();
    });
  }
  async function openRecent(x) {
    try {
      // Opening only needs to READ the file: the browser asks "view", not "edit". Permission to write
      // into it is asked when (and if) the person saves into it.
      if ((await x.handle.queryPermission({ mode: "read" })) !== "granted" &&
          (await x.handle.requestPermission({ mode: "read" })) !== "granted") return toast(t("Access to the file was not allowed."), true);
      const f = await x.handle.getFile();
      f.__handle = x.handle;
      openFile(f);
    } catch (e) {
      if (e.name === "NotFoundError") {
        toast(t("This file was moved or deleted. It was removed from the list."), true, 7000);
        await store("readwrite", (st) => st.delete(x.id)); renderRecent();
      } else toast(e.message, true);
    }
  }

  /* ---------------------------------------------------------------- open */
  F.pick = async () => {
    if (!F.supported) return $("#fileInput").click();
    let h;
    try { [h] = await window.showOpenFilePicker({ types: [{ description: t("PDF document"), accept: { "application/pdf": [".pdf"] } }] }); }
    catch (e) { if (e.name !== "AbortError") $("#fileInput").click(); return; }
    const f = await h.getFile();
    f.__handle = h;
    openFile(f);
  };
  /** Must be called during the drop event: the handle is only available then. */
  F.handleFromDrop = (dt) => {
    if (!F.supported) return null;
    const it = [...(dt.items || [])].find((i) => i.kind === "file" && i.getAsFileSystemHandle);
    return it ? it.getAsFileSystemHandle().catch(() => null) : null;
  };
  /** Called before a file is opened: false when it is too large (with an explanation). */
  F.check = async (file) => {
    if (file.size <= F.maxBytes) return true;
    await modal({ title: t("This PDF is too large to edit in the browser"),
      text: t("“{name}” is {size}; the editor works with PDFs up to {max}.").replace("{name}", file.name).replace("{size}", F.size(file.size)).replace("{max}", F.size(F.maxBytes)) + " " +
            t("To make it smaller: on a Mac, open it in Preview, then File › Export… › Quartz Filter: Reduce File Size; or split it into parts (in Preview, drag pages out of the sidebar). Large PDFs are almost always scans or photos: scanning at 150–200 dpi is enough for documents."),
      ok: t("OK") });
    return false;
  };
  /** Called once a file is open in the editor. */
  F.opened = (file) => {
    F.handle = (file && file.__handle) || null;
    askedFor = null;
    if (!F.handle) try { localStorage.removeItem(CUR); } catch (e) {}
    if (F.handle) remember(F.handle, file.name);
    mark();
  };
  F.closed = () => { F.handle = null; askedFor = null; try { localStorage.removeItem(CUR); } catch (e) {} mark(); renderRecent(); };
  F.afterChange = () => mark();

  /* ---------------------------------------------------------------- save */
  /** Save into the file that was opened. Returns false when that is not possible (the caller
   *  then saves a copy as before). */
  /** Save (⌘S): when the PDF came from a file on the computer, ask whether to replace it or to
   *  save the changes in a new file (once per opened PDF if the person ticks "Don't ask again").
   *  Returns false when there is no such file (the caller then downloads a copy). */
  let askedFor = null;                    // the handle for which "don't ask again" was ticked
  F.save = async () => {
    if (!F.handle || !S.doc) return false;
    await closeEditor(true);
    if (askedFor !== F.handle) {
      const choice = await ask(F.handle.name);
      if (choice === "cancel") return true;
      if (choice === "new") { await F.saveAs(); return true; }
    }
    return writeTo(F.handle);
  };
  /** ⇧⌘S, or "Save as a new file…": a new file chosen by the person; later saves go there. */
  F.saveAs = async () => {
    if (!S.doc) return;
    if (typeof window.showSaveFilePicker !== "function") { download(); return; }
    await closeEditor(true);
    if (window.ACTIVE) await ACTIVE.remove(false);
    let h;
    try { h = await window.showSaveFilePicker({ suggestedName: outName(S.doc.name), types: [{ description: t("PDF document"), accept: { "application/pdf": [".pdf"] } }] }); }
    catch (e) { return; }                                    // cancelled
    if (await writeTo(h)) { F.handle = h; askedFor = null; mark(); }
  };
  async function writeTo(h) {
    try {
      if ((await h.queryPermission({ mode: "readwrite" })) !== "granted" &&
          (await h.requestPermission({ mode: "readwrite" })) !== "granted") { toast(t("Saving into the file was not allowed: a copy is saved instead."), false, 6000); return false; }
    } catch (e) { return false; }
    let ok = false;
    await busy(async () => {
      const bytes = await call("export");
      const w = await h.createWritable();           // written to a temporary file, swapped in on close
      try { await w.write(bytes); await w.close(); }
      catch (e) { try { await w.abort(); } catch (x) {} throw new Error(t("The file could not be saved: {why}").replace("{why}", e.message)); }
      S.dirty = false;
      call("markSaved").catch(() => {});
      ok = true;
      mark();
      toast(t("Saved in “{name}”").replace("{name}", h.name));
      window.PDFE_STATS && PDFE_STATS.event("pdf_saved");
      remember(h, h.name);
    });
    return ok;
  }
  /** "replace", "new" or "cancel" */
  function ask(name) {
    let d = document.getElementById("saveDlg");
    if (!d) {
      d = el(`<div id="saveDlg" class="dlg" hidden role="dialog" aria-modal="true" aria-labelledby="saveDlgTitle"><div class="box">
        <h2 id="saveDlgTitle">${t("Save your changes")}</h2>
        <p class="small">${t("Replace the PDF you opened, or keep it unchanged and save the changes in a new file.")}</p>
        <label class="check"><input type="checkbox" id="saveDlgOnce"> <span>${t("Don't ask again for this PDF")}</span></label>
        <div class="actions"><button class="sd-cancel">${t("Cancel")}</button><button class="sd-new">${t("Save as a new file…")}</button><button class="primary sd-replace"></button></div>
      </div></div>`);
      document.body.appendChild(d);
    }
    d.querySelector(".sd-replace").textContent = t("Replace “{name}”").replace("{name}", name);
    d.querySelector("#saveDlgOnce").checked = false;
    d.hidden = false;
    d.querySelector(".sd-replace").focus();
    return new Promise((res) => {
      const done = (v) => {
        d.hidden = true;
        if (v === "replace" && d.querySelector("#saveDlgOnce").checked) askedFor = F.handle;
        d.onclick = d.onkeydown = null;
        res(v);
      };
      d.onclick = (e) => {
        if (e.target.closest(".sd-replace")) done("replace");
        else if (e.target.closest(".sd-new")) done("new");
        else if (e.target.closest(".sd-cancel") || e.target === d) done("cancel");
      };
      d.onkeydown = (e) => { if (e.key === "Escape") done("cancel"); };
    });
  }
  /** A "Save as" chose a new file: later saves go there. */
  F.adopt = (h) => { if (h && h.kind === "file") { F.handle = h; remember(h, h.name); mark(); } };

  function mark() {
    const s = document.getElementById("saveState");
    if (!s) return;
    const show = typeof S !== "undefined" && !!S.doc;
    s.hidden = !show;
    s.textContent = !show ? "" : S.dirty ? t("Not saved") : F.handle ? t("Saved") : "";
    s.classList.toggle("dirty", show && !!S.dirty);
  }

  /* ---------------------------------------------------------------- start */
  /** The site's home page in the editor's language ("/", "/fr/", "/ar/"…). */
  const home = () => { const l = (window.I18N && I18N.lang) || "en"; return l === "en" ? "/" : `/${l}/`; };
  function homeLinks() {
    const label = t("Home page");
    let logo = document.querySelector("#toolbar .brand .logo");
    if (logo && logo.tagName !== "A") {
      const a = el(`<a class="logo" href="${home()}">P</a>`);
      logo.replaceWith(a); logo = a;
    }
    if (logo) { logo.title = label; logo.setAttribute("aria-label", label); logo.href = home(); }
    const drop = document.querySelector("#empty .drop");
    let p = document.getElementById("homeLink");
    if (drop && !p) {
      p = el(`<p id="homeLink" class="small"><a><span class="hl-arrow" aria-hidden="true">←</span> <span class="hl-text"></span></a></p>`);
      drop.appendChild(p);
    }
    if (p) { p.querySelector("a").href = home(); p.querySelector(".hl-text").textContent = label; }
  }
  function start() {
    homeLinks();
    if (window.I18N && I18N.ready) I18N.ready.then(homeLinks);
    const name = document.getElementById("docName");
    if (name && !document.getElementById("saveState")) name.after(el(`<span id="saveState" class="save-state" hidden></span>`));
    const drop = document.querySelector("#empty .drop");
    if (drop && !document.getElementById("sizeNote")) {
      const note = el(`<p id="sizeNote" class="small muted"></p>`);
      // written once the translations are loaded (the page watcher does not split sentences)
      const fill = () => { note.textContent = t("PDFs up to {max}.").replace("{max}", F.size(F.maxBytes)) + " " +
        (F.supported ? t("Save lets you replace your file or save a new one.") : t("Save downloads the edited PDF.")); };
      fill();
      if (window.I18N && I18N.ready) I18N.ready.then(fill);
      const lic = drop.querySelector("p.muted.small");
      (lic ? lic.parentNode : drop).insertBefore(note, lic || null);
    }
    renderRecent();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
