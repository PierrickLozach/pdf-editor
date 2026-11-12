/* PDF Editor - website pages: language switcher, footer year. No cookies, no accounts. */
const $ = (s, el = document) => el.querySelector(s);
const KEY = "pdfe.lang";
const sel = $("#langSwitch");
if (sel) {
  let chosen = null;
  try { chosen = localStorage.getItem(KEY); } catch (e) {}
  if (!chosen) sel.value = "auto";                       // following the browser
  sel.addEventListener("change", () => {
    if (sel.value === "auto") {                           // back to the browser's language
      try { localStorage.removeItem(KEY); } catch (e) {}
      location.reload();
      return;
    }
    try { localStorage.setItem(KEY, sel.value); } catch (e) {}
    location.href = sel.selectedOptions[0].dataset.href + location.hash;
  });
}
const y = $("#year"); if (y) y.textContent = new Date().getFullYear();
// privacy page: "Do not count my visits in this browser"
const opt = $("#statsOptOut");
if (opt) {
  const off = () => { try { return localStorage.getItem("pdfe.noStats") === "1"; } catch (e) { return false; } };
  opt.checked = off();
  const dnt = navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true;
  if (dnt) { opt.checked = true; opt.disabled = true; opt.title = "Your browser already asks websites not to track you"; }
  opt.addEventListener("change", () => { try { if (opt.checked) localStorage.setItem("pdfe.noStats", "1"); else localStorage.removeItem("pdfe.noStats"); } catch (e) {} });
}
