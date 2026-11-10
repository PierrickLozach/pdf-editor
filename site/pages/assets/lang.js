/* Show the site in the browser's language, unless the visitor chose another one with the switcher
   (then remembered). Runs first, before the page is drawn. Detected languages are never stored,
   so the site keeps following the browser's settings. */
(function () {
  var KEY = "pdfe.lang", d = document.documentElement;
  var ALIASES = { iw: "he", "zh-hans": "zh", "zh-cn": "zh", "zh-sg": "zh" };
  var here = d.lang, alts = {};
  var links = document.querySelectorAll('link[rel="alternate"][hreflang]');
  for (var i = 0; i < links.length; i++) { var h = links[i].getAttribute("hreflang"); if (h !== "x-default") alts[h] = links[i].getAttribute("href"); }
  var want = null;
  try { want = localStorage.getItem(KEY); } catch (e) {}
  if (!want || !alts[want]) {
    want = null;
    var langs = navigator.languages || [navigator.language || ""];
    for (var j = 0; j < langs.length && !want; j++) {
      var full = String(langs[j]).toLowerCase(), c = ALIASES[full] || ALIASES[full.split("-")[0]] || full.split("-")[0];
      if (alts[c]) want = c;
    }
  }
  window.PDFE_BROWSER_LANG = want;
  if (want && want !== here && alts[want]) {
    var u = new URL(alts[want], location.href);
    if (u.pathname !== location.pathname) location.replace(u.pathname + location.search + location.hash);
  }
})();
