/* PDF Editor - keep the toolbar on one line whatever the language and the window width:
 * hide button labels step by step (fit1: file buttons, fit2: all, fit3: the "saved" note). */
(function () {
  const tb = document.getElementById("toolbar");
  if (!tb) return;
  const STEPS = ["fit1", "fit2", "fit3", "fit4"];
  let busy = false;
  function fit() {
    if (busy) return;
    busy = true;
    tb.classList.remove(...STEPS);
    for (const s of STEPS) {
      if (tb.scrollWidth <= tb.clientWidth + 1) break;
      tb.classList.add(s);
    }
    busy = false;
  }
  new ResizeObserver(fit).observe(tb);
  new MutationObserver(() => requestAnimationFrame(fit)).observe(tb, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  document.addEventListener("DOMContentLoaded", fit);
  window.addEventListener("load", fit);
  fit();
})();
