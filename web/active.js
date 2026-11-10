/* PDF Editor - active content in PDFs (scripts, actions that open programs or web pages by
 * themselves, attached files, XFA forms). The editor never runs any of it; this makes sure an
 * edited PDF does not pass it on: when a PDF has some, a notice offers to remove it, and saving
 * removes it unless the person chose to keep it. Uses the globals of app.js. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const A = (window.ACTIVE = { found: 0, keep: false });
  const NAMES = { JavaScript: "scripts", Launch: "program launch", SubmitForm: "form sending", ImportData: "data import", URI: "unsafe links",
    automatic: "automatic actions", attachment: "attached files", XFA: "XFA form", Rendition: "media", Sound: "media", Movie: "media", RichMediaExecute: "media", GoToE: "embedded document" };
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };

  function bar() {
    let b = document.getElementById("activeBar");
    if (!b) {
      b = el(`<div id="activeBar" class="warnbox" role="alert" hidden><span class="ab-text"></span>
        <button class="primary ab-remove">${t("Remove it")}</button> <button class="ab-keep">${t("Keep it")}</button></div>`);
      document.getElementById("viewer").before(b);
      b.querySelector(".ab-remove").onclick = () => A.remove(true);
      b.querySelector(".ab-keep").onclick = () => { A.keep = true; b.hidden = true; toast(t("Kept: the saved PDF will still contain it.")); };
    }
    return b;
  }
  /** After a PDF is opened. */
  A.check = async () => {
    A.found = 0; A.keep = false;
    const b = document.getElementById("activeBar");
    if (b) b.hidden = true;
    let r;
    try { r = await call("activeContent"); } catch (e) { return; }
    if (!r || !r.total) return;
    A.found = r.total;
    const kinds = [...new Set(Object.keys(r.kinds).map((k) => t(NAMES[k] || k)))].join(", ");
    const box = bar();
    box.querySelector(".ab-text").textContent = t("This PDF contains active content ({kinds}). The editor never runs it, but other PDF readers may. It is removed when you save, unless you keep it.").replace("{kinds}", kinds) + " ";
    box.hidden = false;
  };
  /** Remove it now (from the notice) or before saving. */
  A.remove = async (fromBar) => {
    if (!A.found || A.keep) return;
    const r = await call("removeActiveContent");
    applyInfo(r);
    A.found = 0;
    const b = document.getElementById("activeBar");
    if (b) b.hidden = true;
    if (fromBar) toast(t("Active content removed. You can undo it."));
  };
  A.closed = () => { A.found = 0; A.keep = false; const b = document.getElementById("activeBar"); if (b) b.hidden = true; };
})();
