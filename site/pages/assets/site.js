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
// landing page: Pro prices from the publisher's settings (shown only while the shop is open)
const priceEl = document.querySelector("[data-pro-price]");
if (priceEl) fetch("/api/pro/config").then((r) => (r.ok ? r.json() : null)).then((c) => {
  if (!c || !c.sales || !c.plans.length) return;
  const lang = document.documentElement.lang || "en";
  const money = (n) => { try { return new Intl.NumberFormat(lang, { style: "currency", currency: c.currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch (e) { return n + " " + c.currency; } };
  const m = c.plans.find((p) => p.id === "monthly"), y = c.plans.find((p) => p.id === "yearly"), l = c.plans.find((p) => p.id === "lifetime");
  const from = priceEl.dataset.from || "from", per = { month: priceEl.dataset.month || "/ month", year: priceEl.dataset.year || "/ year", once: priceEl.dataset.once || "once" };
  const parts = [];
  if (m) parts.push(money(m.price) + " <small>" + per.month + "</small>");
  if (y) parts.push(money(y.price) + " <small>" + per.year + "</small>");
  if (l) parts.push(money(l.price) + " <small>" + per.once + "</small>");
  priceEl.innerHTML = parts.slice(0, 2).join(" · ") + (l && parts.length > 2 ? "<br><small>" + money(l.price) + " " + per.once + "</small>" : "");
}).catch(() => {});
