/* PDF Editor - the account inside the editor (uses window.Vault and the globals of app.js).
 *  - toolbar: "Sign in" or the account's initials, with a menu
 *  - start screen: "My PDFs" (open, rename, delete, older versions) and "Add PDFs"
 *  - Save: a PDF from "My PDFs" is saved back as a new version; another PDF is added to them
 *  - a dialog to create an account or sign in, with a passkey */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const V = window.Vault;
  const A = (window.ACCOUNT = { fileId: null, savedVersion: 0 });   // fileId of the open PDF if it is in "My PDFs"
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  const fmtDate = (ms) => new Date(ms).toLocaleString(document.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" });
  const initials = (n) => (String(n || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("") || "?").toUpperCase();
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };

  /* ---------------------------------------------------------------- toolbar */
  function renderButton() {
    let box = $("#acctArea");
    if (!box) { box = document.createElement("div"); box.id = "acctArea"; $("#toolbar").appendChild(box); }
    box.innerHTML = "";
    const acc = V.account;
    if (!acc) {
      const b = el(`<button class="acct-signin" id="btnSignIn">${t("Sign in")}</button>`);
      b.onclick = () => openAuth("signin");
      box.appendChild(b);
      return;
    }
    const btn = el(`<button class="acct-btn" id="acctBtn" aria-haspopup="menu" aria-expanded="false"><span class="acct-avatar"></span></button>`);
    btn.title = acc.name;
    btn.querySelector(".acct-avatar").textContent = initials(acc.name);
    const menu = el(`<div class="acct-menu" id="acctMenu" role="menu" hidden>
      <div class="who"><b></b><span>${t("Passkey account · files kept on this device")}</span></div>
      <button role="menuitem" id="mMyPdfs">${t("My PDFs")}</button>
      <button role="menuitem" id="mRename">${t("Change my name")}</button>
      <button role="menuitem" id="mSignOut">${t("Sign out")}</button>
      <button role="menuitem" id="mDelete" class="danger">${t("Delete my account")}</button>
    </div>`);
    menu.querySelector(".who b").textContent = acc.name;
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
    document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
    menu.querySelector("#mMyPdfs").onclick = () => { menu.hidden = true; showHome(); };
    menu.querySelector("#mRename").onclick = async () => {
      menu.hidden = true;
      const n = await modal({ title: t("Change my name"), text: t("This name is only shown on this device."), input: true, ok: t("Save") });
      if (n && n.trim()) { await V.renameAccount(n); toast(t("Name saved")); }
    };
    menu.querySelector("#mSignOut").onclick = async () => {
      menu.hidden = true;
      if (S.doc && S.dirty && A.fileId && !(await modal({ title: t("Sign out?"), text: t("Your edits have not been saved and will be lost."), ok: t("Sign out") }))) return;
      if (A.fileId && S.doc) await closeDoc();
      V.signOut();
      toast(t("Signed out. Your PDFs stay encrypted on this device."));
    };
    menu.querySelector("#mDelete").onclick = async () => {
      menu.hidden = true;
      const ok = await modal({ title: t("Delete my account?"), text: t("Your account and every PDF saved in it are deleted from this device for good. Your passkey will be asked to confirm."), ok: t("Delete my account"), danger: true });
      if (!ok) return;
      try {
        if (A.fileId && S.doc) await closeDoc();
        const n = await V.deleteAccount();
        toast(t("Account deleted") + (n ? ` (${n} PDF)` : ""));
        hint();
      } catch (e) { toast(V.explain(e), true); }
    };
    box.append(btn, menu);
  }

  /* ---------------------------------------------------------------- start screen: My PDFs */
  function homeBox() {
    let box = $("#myPdfs");
    if (!box) {
      box = el(`<section id="myPdfs" aria-labelledby="myPdfsTitle">
        <div class="mp-head"><h2 id="myPdfsTitle">${t("My PDFs")}</h2><button class="primary" id="mpAdd">${t("Add PDFs")}</button></div>
        <p class="mp-note small muted">${t("Encrypted and kept on this device only.")}</p>
        <ul id="mpList"></ul>
        <p id="mpEmpty" class="small muted" hidden>${t("No PDF yet. Add one, or open a PDF and save it.")}</p>
        <input id="mpInput" type="file" accept="application/pdf,.pdf" multiple hidden>
      </section>`);
      $("#empty .drop").prepend(box);
      box.querySelector("#mpAdd").onclick = () => box.querySelector("#mpInput").click();
      box.querySelector("#mpInput").onchange = async (e) => { const f = [...e.target.files]; e.target.value = ""; await addFiles(f); };
    }
    return box;
  }
  async function showHome() {
    const acc = V.account;
    const box = $("#myPdfs");
    if (!acc) { if (box) box.hidden = true; hint(); return; }
    if (S.doc) {   // go back to the start screen
      if (S.dirty && !(await modal({ title: t("Close this PDF?"), text: t("Your edits have not been saved and will be lost."), ok: t("Close") }))) return;
      await closeDoc();
    }
    const b = homeBox();
    b.hidden = false;
    const hb = $("#acctHint"); if (hb) hb.hidden = true;
    const files = await V.list();
    const ul = b.querySelector("#mpList");
    ul.innerHTML = "";
    for (const f of files) {
      const li = el(`<li class="mp-item">
        <button class="mp-open" title="${t("Open")}"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg><span class="mp-name"></span></button>
        <span class="mp-meta"></span>
        <button class="mp-more icon" title="${t("More")}" aria-haspopup="menu">⋯</button>
      </li>`);
      li.dataset.id = f.id;
      li.querySelector(".mp-name").textContent = f.name;
      li.querySelector(".mp-meta").textContent = `${fmtDate(f.updated)} · ${fmtSize(f.size)}` + (f.versions.length > 1 ? ` · ${f.versions.length} ${t("versions")}` : "");
      li.querySelector(".mp-open").onclick = () => openFromVault(f.id);
      li.querySelector(".mp-more").onclick = (e) => fileMenu(e, f);
      ul.appendChild(li);
    }
    b.querySelector("#mpEmpty").hidden = files.length > 0;
  }
  function fileMenu(e, f) {
    e.stopPropagation();
    $$(".mp-menu").forEach((m) => m.remove());
    const m = el(`<div class="mp-menu" role="menu">
      <button data-a="download">${t("Download")}</button>
      <button data-a="rename">${t("Rename")}</button>
      ${f.versions.length > 1 ? `<button data-a="versions">${t("Previous versions")}</button>` : ""}
      <button data-a="delete" class="danger">${t("Delete")}</button></div>`);
    e.target.closest(".mp-item").appendChild(m);
    const close = () => m.remove();
    setTimeout(() => document.addEventListener("pointerdown", function h(ev) { if (!m.contains(ev.target)) { close(); document.removeEventListener("pointerdown", h); } }), 0);
    m.onclick = async (ev) => {
      const a = ev.target.dataset.a;
      if (!a) return;
      close();
      if (a === "download") { const r = await V.load(f.id); triggerDownload(r.bytes, r.name); }
      if (a === "rename") {
        const n = await modal({ title: t("Rename"), text: f.name, input: true, ok: t("Save") });
        if (n && n.trim()) { await V.renameFile(f.id, n.trim().replace(/(\.pdf)?$/i, ".pdf")); showHome(); }
      }
      if (a === "delete") {
        if (await modal({ title: t("Delete this PDF?"), text: f.name, ok: t("Delete"), danger: true })) { await V.remove(f.id); toast(t("Deleted")); showHome(); }
      }
      if (a === "versions") versionsDialog(f);
    };
  }
  async function versionsDialog(f) {
    const d = $("#versionsDlg");
    const ul = d.querySelector("ul");
    ul.innerHTML = "";
    f.versions.forEach((v, i) => {
      const li = el(`<li><span>${fmtDate(v.time)} · ${fmtSize(v.size)}${i === 0 ? ` <b>(${t("current")})</b>` : ""}</span><button>${t("Open")}</button></li>`);
      li.querySelector("button").onclick = () => { d.hidden = true; openFromVault(f.id, i); };
      ul.appendChild(li);
    });
    d.querySelector("h2").textContent = f.name;
    d.hidden = false;
    d.querySelector(".close").focus();
  }

  async function addFiles(files) {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!pdfs.length) return toast(t("Please choose a PDF file"), true);
    await busy(async () => {
      for (const f of pdfs) await V.save(new Uint8Array(await f.arrayBuffer()), f.name);
    });
    V.persist();
    toast(pdfs.length > 1 ? t("{n} PDFs added").replace("{n}", pdfs.length) : t("Added to My PDFs"));
    showHome();
  }

  async function openFromVault(id, version = 0) {
    await busy(async () => {
      const r = await V.load(id, version);
      await engineReady;
      const info = await call("open", r.bytes, r.name);
      $("#resume").hidden = true;
      loadDoc(info, true);
      A.fileId = id;
      markSaved();
      if (version) toast(t("Older version opened: saving makes it the current version."));
    });
  }

  async function closeDoc() {
    await call("discard");
    S.doc = null; S.dirty = false; S.hits = [];
    A.fileId = null;
    document.body.classList.remove("has-doc");
    $("#pages").innerHTML = ""; $("#thumbs").innerHTML = "";
    $("#docName").textContent = t("PDF Editor"); document.title = t("PDF Editor");
    closeFind();
    updateButtons();
    markSaved();
  }

  /* ---------------------------------------------------------------- saving */
  function markSaved() {
    const s = $("#saveState");
    if (!s) return;
    s.hidden = !A.fileId;
    s.textContent = A.fileId ? (S.dirty ? t("Not saved") : t("Saved in My PDFs")) : "";
    s.classList.toggle("dirty", !!S.dirty);
  }
  /** Save into the account. Returns false when there is no account (the caller downloads instead). */
  A.save = async () => {
    if (!V.account) return false;
    await closeEditor(true);
    await busy(async () => {
      const bytes = await call("export");
      const r = await V.save(bytes, S.doc.name, A.fileId);
      A.fileId = r.id;
      S.dirty = false;
      markSaved();
      toast(t("Saved in My PDFs"));
    });
    V.persist();
    return true;
  };
  A.afterChange = () => markSaved();
  A.closed = () => { A.fileId = null; markSaved(); };

  /* ---------------------------------------------------------------- sign in / create account */
  function hint() {
    let h = $("#acctHint");
    if (V.account || !V.supported()) { if (h) h.hidden = true; return; }
    if (!h) {
      h = el(`<p id="acctHint" class="small"><button class="link" id="hintCreate">${t("Create a free account")}</button> ${t("to keep your PDFs here and save your changes to them. No password: a passkey.")}</p>`);
      $("#empty .drop").prepend(h);
      h.querySelector("#hintCreate").onclick = () => openAuth("create");
    }
    h.hidden = false;
    const b = $("#myPdfs"); if (b) b.hidden = true;
  }

  function openAuth(mode) {
    const d = $("#authDlg");
    const set = (m) => {
      d.dataset.mode = m;
      d.querySelector("h2").textContent = m === "create" ? t("Create your account") : t("Sign in");
      d.querySelector(".auth-create").hidden = m !== "create";
      d.querySelector(".auth-signin").hidden = m === "create";
      d.querySelector(".err").hidden = true;
      setTimeout(() => (m === "create" ? d.querySelector("#authName") : d.querySelector("#authGo")).focus(), 30);
    };
    set(mode);
    d.hidden = false;
    d.querySelector("#authToCreate").onclick = () => set("create");
    d.querySelector("#authToSignin").onclick = () => set("signin");
    d.querySelector(".close").onclick = () => (d.hidden = true);
    d.onkeydown = (e) => { if (e.key === "Escape") d.hidden = true; };
    const run = async (fn) => {
      const err = d.querySelector(".err");
      err.hidden = true;
      d.classList.add("working");
      try {
        await fn();
        d.hidden = true;
      } catch (e) { err.textContent = V.explain(e); err.hidden = false; }
      finally { d.classList.remove("working"); }
    };
    d.querySelector("#authCreateForm").onsubmit = (e) => {
      e.preventDefault();
      run(async () => {
        const acc = await V.create(d.querySelector("#authName").value);
        V.persist();
        toast(t("Welcome, {name}! Your account is ready.").replace("{name}", acc.name));
        if (S.doc && !A.fileId) {           // a PDF is open: offer to keep it
          if (await modal({ title: t("Keep this PDF in My PDFs?"), text: S.doc.name, ok: t("Save") })) await A.save();
        } else if (!S.doc) showHome();
      });
    };
    d.querySelector("#authGo").onclick = () => run(async () => {
      const acc = await V.signIn();
      toast(t("Signed in as {name}").replace("{name}", acc.name));
      if (!S.doc) showHome();
    });
  }

  /* ---------------------------------------------------------------- start */
  function dialogs() {
    document.body.appendChild(el(`<div id="authDlg" class="dlg" hidden role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <div class="box">
        <div class="dlg-head"><h2 id="authTitle"></h2><button class="icon close" title="${t("Close (Esc)")}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <p class="err warnbox" role="alert" hidden></p>
        <div class="auth-create">
          <p class="small">${t("No password to remember: your device creates a passkey (fingerprint, face, PIN or phone). Your PDFs are encrypted and kept on this device only.")}</p>
          <form id="authCreateForm">
            <label class="field">${t("Your name")}<input id="authName" type="text" autocomplete="name" maxlength="60" required></label>
            <div class="actions"><button type="submit" class="primary">${t("Create my account")}</button></div>
          </form>
          <p class="small muted">${t("Already have an account on this device?")} <button class="link" id="authToSignin">${t("Sign in")}</button></p>
        </div>
        <div class="auth-signin">
          <p class="small">${t("Use the passkey you created for this site.")}</p>
          <div class="actions"><button class="primary" id="authGo">${t("Sign in with a passkey")}</button></div>
          <p class="small muted">${t("No account yet?")} <button class="link" id="authToCreate">${t("Create one")}</button></p>
        </div>
      </div></div>`));
    document.body.appendChild(el(`<div id="versionsDlg" class="dlg" hidden role="dialog" aria-modal="true">
      <div class="box"><div class="dlg-head"><h2></h2><button class="icon close" title="${t("Close (Esc)")}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <p class="small muted">${t("The last 5 saved versions are kept.")}</p><ul class="versions"></ul></div></div>`));
    const vd = $("#versionsDlg");
    vd.querySelector(".close").onclick = () => (vd.hidden = true);
    vd.onkeydown = (e) => { if (e.key === "Escape") vd.hidden = true; };
    // "Saved / Not saved" next to the file name
    $("#docName").after(el(`<span id="saveState" class="save-state" hidden></span>`));   // inside .brand, after the name
  }

  async function start() {
    if (!V || !V.supported()) return;               // no passkeys here: the editor works without accounts
    dialogs();
    V.onChange(() => { renderButton(); if (!S.doc) showHome(); markSaved(); });
    await V.resume().catch(() => null);
    renderButton();
    if (!S.doc) showHome();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
