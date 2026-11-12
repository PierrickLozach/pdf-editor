/* PDF Editor - first steps (uses the globals of app.js).
 * The first time someone opens a PDF, a pulsing ring and a bubble point at a line of text:
 * "Click any text to change it". It goes away at the first click or key press, or after 9 seconds,
 * and is never shown again (localStorage pdfe.coachSeen). It never blocks a click. */
(function () {
  "use strict";
  const KEY = "pdfe.coachSeen";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const seen = () => { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return true; } };
  if (seen()) return;
  let shown = null, timer = null;

  function done() {
    try { localStorage.setItem(KEY, "1"); } catch (e) {}
    clearTimeout(timer);
    if (shown) { shown.classList.add("bye"); const s = shown; setTimeout(() => s.remove(), 300); shown = null; }
    obs.disconnect();
    removeEventListener("pointerdown", done, true);
    removeEventListener("keydown", done, true);
  }

  function tryShow() {
    if (shown || seen() || typeof S === "undefined" || !S.doc || S.tool !== "edit") return;
    const pageEl0 = document.querySelector("#pages .page");
    if (!pageEl0) return;
    const vr = document.getElementById("viewer").getBoundingClientRect();
    // a text line big enough to point at, in view
    const span = [...pageEl0.querySelectorAll(".spans .span:not(.locked)")].find((x) => {
      const r = x.getBoundingClientRect();
      return r.width > 40 && r.height > 8 && r.top > vr.top + 20 && r.bottom < vr.bottom - 90;
    });
    if (!span) return;
    const layer = span.closest(".layer");
    const c = document.createElement("div");
    c.className = "coach";
    c.setAttribute("role", "status");
    c.innerHTML = `<span class="coach-ring"></span><span class="coach-bubble"></span>`;
    c.querySelector(".coach-bubble").textContent = t("Click any text to change it");
    const lr = layer.getBoundingClientRect(), r = span.getBoundingClientRect();
    c.style.left = r.left - lr.left + "px";
    c.style.top = r.top - lr.top + "px";
    c.style.width = r.width + "px";
    c.style.height = r.height + "px";
    layer.appendChild(c);
    shown = c;
    addEventListener("pointerdown", done, true);
    addEventListener("keydown", done, true);
    timer = setTimeout(done, 9000);
  }

  // the text of a page arrives a moment after the page is drawn
  const obs = new MutationObserver(() => { if (!shown) requestAnimationFrame(tryShow); });
  function start() {
    const pages = document.getElementById("pages");
    if (pages) obs.observe(pages, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
