/* First visit only: show the site in the visitor's language (blocking, runs before the page is drawn).
   A language chosen with the switcher is remembered and always wins. */
(function () {
  var KEY = "pdfe.lang", d = document.documentElement;
  var here = d.lang, alts = {};
  var links = document.querySelectorAll('link[rel="alternate"][hreflang]');
  for (var i = 0; i < links.length; i++) { var h = links[i].getAttribute("hreflang"); if (h !== "x-default") alts[h] = links[i].getAttribute("href"); }
  var want = null;
  try { want = localStorage.getItem(KEY); } catch (e) {}
  if (!want) {
    var langs = navigator.languages || [navigator.language || ""];
    for (var j = 0; j < langs.length && !want; j++) { var c = String(langs[j]).toLowerCase().split("-")[0]; if (alts[c]) want = c; }
    try { if (want) localStorage.setItem(KEY, want); } catch (e) {}
  }
  if (want && want !== here && alts[want]) {
    var u = new URL(alts[want], location.href);
    if (u.pathname !== location.pathname) location.replace(u.pathname + location.search + location.hash);
  }
})();
