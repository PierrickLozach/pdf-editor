/* PDF Editor - "Reduce file size" and the size limit of My PDFs (uses the globals of app.js).
 *  - a button in the page panel opens a small window: current size, two levels, Reduce
 *  - window.REDUCE.tooLarge(size, ctx) explains the limit and how to get under it */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const LIMIT = () => (window.Vault && Vault.maxFileBytes) || 200 * 1024 * 1024;
  const lang = () => document.documentElement.lang || "en";
  const mb = (b) => {           // sizes in the person's language: "4.6 MB", "4,6 Mo"
    const big = b >= 1048576, v = big ? b / 1048576 : Math.max(1, Math.round(b / 1024));
    const num = v.toLocaleString(lang(), { maximumFractionDigits: big && v < 10 ? 1 : 0 });
    return `${num} ${t(big ? "MB" : "KB")}`;
  };
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };
  const R = (window.REDUCE = {});

  function dialog() {
    let d = document.getElementById("reduceDlg");
    if (d) return d;
    d = el(`<div id="reduceDlg" class="dlg" hidden role="dialog" aria-modal="true" aria-labelledby="reduceTitle">
      <div class="box">
        <div class="dlg-head"><h2 id="reduceTitle">${t("Reduce file size")}</h2><button class="icon close" title="${t("Close (Esc)")}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <p class="warnbox rd-limit" hidden></p>
        <p class="small"><span class="rd-now"></span></p>
        <p class="small">${t("Photos and scanned pages are compressed; text and drawings stay sharp and editable. You can undo it.")}</p>
        <label class="rd-opt"><input type="radio" name="rdLevel" value="smaller" checked> <span><b>${t("Smaller")}</b> – ${t("good for printing (about 200 dpi)")}</span></label>
        <label class="rd-opt"><input type="radio" name="rdLevel" value="smallest"> <span><b>${t("Smallest")}</b> – ${t("for email and screens (about 120 dpi)")}</span></label>
        <details class="rd-tips small"><summary>${t("Other ways to make a PDF smaller")}</summary><ul>
          <li>${t("Delete pages you do not need, or split a long PDF: delete half of the pages, save, then do the same with the other half.")}</li>
          <li>${t("On a Mac: open the PDF in Preview, File › Export, Quartz Filter: Reduce File Size.")}</li>
          <li>${t("When scanning: 150–200 dpi is enough for documents (300 dpi in black and white for small print).")}</li>
        </ul></details>
        <div class="actions"><button class="rd-cancel">${t("Cancel")}</button><button class="primary rd-go">${t("Reduce")}</button></div>
      </div></div>`);
    document.body.appendChild(d);
    d.querySelector(".close").onclick = d.querySelector(".rd-cancel").onclick = () => (d.hidden = true);
    d.onkeydown = (e) => { if (e.key === "Escape") d.hidden = true; };
    return d;
  }

  /** Open the window for the PDF in the editor. opts.limitText: explain the My PDFs limit first. */
  R.open = async (opts = {}) => {
    if (!S.doc) return;
    if (S.ed) await closeEditor(true);
    const d = dialog();
    const lim = d.querySelector(".rd-limit");
    lim.hidden = !opts.limitText;
    lim.textContent = opts.limitText || "";
    d.querySelector(".rd-now").textContent = t("Calculating the size…");
    d.hidden = false;
    d.querySelector(".rd-go").focus();
    const size = opts.size || (await call("export")).length;
    d.querySelector(".rd-now").textContent = window.Vault && Vault.account
      ? t("Current size: {a} · My PDFs accept up to {b}").replace("{a}", mb(size)).replace("{b}", mb(LIMIT()))
      : t("Current size: {a}").replace("{a}", mb(size));
    return new Promise((res) => {
      d.querySelector(".rd-go").onclick = async () => {
        const level = d.querySelector('input[name="rdLevel"]:checked').value;
        d.hidden = true;
        const r = await busy(async () => {
          toast(t("Reducing the size…"), false, 120000);
          const info = await call("reduceSize", level);
          applyInfo(info);
          return info;
        });
        if (!r) return res(null);
        if (!r.images) toast(t("This PDF has no large photos or scans to compress: it is already about as small as it can be."), false, 8000);
        else toast(t("Size reduced: {a} → {b}").replace("{a}", mb(r.before)).replace("{b}", mb(r.after)), false, 8000);
        res(r);
      };
      d.querySelector(".rd-cancel").addEventListener("click", () => res(null), { once: true });
    });
  };

  /** A PDF over the My PDFs limit: say so, and offer to reduce it (it is opened in the editor). */
  R.tooLarge = async (size, name, bytes) => {
    const text = `${t("“{name}” is {size}; a PDF in My PDFs can be up to {limit}.").replace("{name}", name).replace("{size}", mb(size)).replace("{limit}", mb(LIMIT()))}`;
    if (bytes) {                                   // a file being added: open it to reduce it
      if (!(await modal({ title: t("This PDF is too large for My PDFs"), text: text + " " + t("Reduce its size? It opens in the editor first."), ok: t("Reduce its size") }))) return false;
      await busy(async () => { const info = await call("open", bytes, name); loadDoc(info, true); if (window.ACCOUNT) ACCOUNT.closed(); });
    }
    const r = await R.open({ limitText: text, size });
    if (!r) return false;
    if (r.after > LIMIT()) { toast(t("Still too large. Try “Smallest”, or delete pages and save the PDF in two parts."), true, 10000); return false; }
    if (window.ACCOUNT && Vault.account && (await modal({ title: t("Save it in My PDFs?"), text: `${name} · ${mb(r.after)}`, ok: t("Save") }))) await ACCOUNT.save();
    return true;
  };

  function button() {
    const merge = document.getElementById("btnMerge");
    if (!merge || document.getElementById("btnReduce")) return;
    const b = el(`<button id="btnReduce" class="needs-doc wide" title="${t("Compress photos and scans to make the PDF smaller")}">${t("Reduce file size…")}</button>`);
    b.disabled = !S.doc;
    b.onclick = () => R.open();
    merge.after(b);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", button); else button();
})();
