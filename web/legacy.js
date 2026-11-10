/* PDF Editor - accounts were removed (11/2026). PDFs that people saved in the old "My PDFs" are
 * still encrypted in this browser: this offers, once, to download them (one passkey sign-in), then
 * erases the old data. Nothing happens for people who never had an account. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const DB = "pdf-editor-vault";
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };

  /** {accounts, files} of the old storage, or null when it does not exist (never creates it). */
  function inspect() {
    return new Promise((res) => {
      let created = false;
      const r = indexedDB.open(DB);
      r.onupgradeneeded = (e) => { if (e.oldVersion === 0) { created = true; r.transaction.abort(); } };
      r.onerror = () => res(null);
      r.onsuccess = () => {
        const d = r.result;
        if (created || !d.objectStoreNames.contains("accounts")) { d.close(); return res(null); }
        const x = d.transaction(["accounts", "files"], "readonly");
        const a = x.objectStore("accounts").getAll(), f = x.objectStore("files").count();
        x.oncomplete = () => { const out = { accounts: a.result || [], files: f.result || 0 }; d.close(); res(out); };
        x.onerror = () => { d.close(); res(null); };
      };
    });
  }
  async function erase(accounts) {
    for (const a of accounts || []) for (const id of a.credIds || []) {
      try { if (PublicKeyCredential.signalUnknownCredential) await PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: id }); } catch (e) {}
    }
    if (window.Vault && Vault.close) await Vault.close();          // its own connection would block the deletion
    await new Promise((res) => {
      const q = indexedDB.deleteDatabase(DB);
      q.onsuccess = q.onerror = () => res();
      setTimeout(res, 5000);                                         // another tab still has it open: done when it closes
    });
    try { sessionStorage.removeItem("pdfe.vaultSession"); } catch (e) {}
  }
  function loadVault() {
    if (window.Vault) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      const me = document.currentScript || [...document.scripts].find((x) => /legacy\.js/.test(x.src));
      const v = me ? new URL(me.src).searchParams.get("v") : "";
      s.src = "legacy/vault.js" + (v ? "?v=" + v : "");            // only loaded for people who still have old PDFs
      s.onload = res; s.onerror = () => rej(new Error("vault.js"));
      document.head.appendChild(s);
    });
  }

  async function start() {
    const st = await inspect();
    if (!st) return;
    if (!st.files) { await erase(st.accounts); return; }           // accounts without PDFs: just clean up
    const box = el(`<section id="legacyBox" class="warnbox" role="region" aria-label="${t("My PDFs")}">
      <p><b>${t("Accounts have been removed.")}</b> <span class="lg-count"></span></p>
      <p class="small">${t("Download them now: they will then be deleted from this browser. Your passkey is asked once to unlock them.")}</p>
      <div class="actions"><button class="primary lg-dl">${t("Download my PDFs")}</button> <button class="lg-del">${t("Delete them")}</button></div></section>`);
    box.querySelector(".lg-count").textContent = (st.files > 1 ? t("{n} PDFs saved in “My PDFs” are still in this browser.").replace("{n}", st.files) : t("1 PDF saved in “My PDFs” is still in this browser."));
    document.querySelector("#empty .drop").prepend(box);
    const go = async () => {
      try {
        await loadVault();
        await Vault.signIn();
        const list = await Vault.list();
        for (const f of list) { const r = await Vault.load(f.id); triggerDownload(r.bytes, r.name); await new Promise((x) => setTimeout(x, 400)); }
        const left = (await inspect()) || { accounts: [], files: 0 };
        const mine = Vault.account && Vault.account.id;
        Vault.signOut();
        toast(t("{n} PDF downloaded.").replace("{n}", list.length), false, 7000);
        if (left.accounts.length <= 1) { await erase(left.accounts); box.remove(); }
        else {                                        // other accounts on this browser keep theirs until their turn
          await removeAccount(mine);
          const again = await inspect();
          if (!again || !again.files) { await erase(again && again.accounts); box.remove(); }
          else box.querySelector(".lg-count").textContent = t("{n} PDFs saved in “My PDFs” are still in this browser.").replace("{n}", again.files);
        }
      } catch (e) { toast((window.Vault && Vault.explain) ? Vault.explain(e) : e.message, true); }
    };
    box.querySelector(".lg-dl").onclick = go;
    box.querySelector(".lg-del").onclick = async () => {
      if (!(await modal({ title: t("Delete them?"), text: t("The PDFs saved in “My PDFs” are deleted from this browser for good."), ok: t("Delete"), danger: true }))) return;
      await erase(st.accounts); box.remove(); toast(t("Deleted"));
    };
  }
  function removeAccount(id) {
    return new Promise((res) => {
      const r = indexedDB.open(DB);
      r.onsuccess = () => {
        const d = r.result, x = d.transaction(["accounts", "files", "blobs"], "readwrite");
        const fs = x.objectStore("files"), bs = x.objectStore("blobs");
        const q = fs.getAll();
        q.onsuccess = () => { for (const f of q.result) if (f.account === id) { for (const v of f.versions) bs.delete(v.blob); fs.delete(f.id); } x.objectStore("accounts").delete(id); };
        x.oncomplete = () => { d.close(); res(); };
        x.onerror = () => { d.close(); res(); };
      };
      r.onerror = () => res();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
