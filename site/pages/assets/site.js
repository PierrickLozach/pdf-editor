/* PDF Editor - website pages: language switcher, footer year. No cookies, no accounts. */
const $ = (s, el = document) => el.querySelector(s);
const KEY = "pdfe.lang";
const sel = $("#langSwitch");
if (sel) {
  sel.addEventListener("change", () => {
    try { localStorage.setItem(KEY, sel.value); } catch (e) {}
    const opt = sel.selectedOptions[0];
    location.href = opt.dataset.href + location.hash;
  });
}
const y = $("#year"); if (y) y.textContent = new Date().getFullYear();
