/* PDF Editor - anonymous visit counting (our own, no third party, no cookie).
 * Sends to /api/hit: the page, and for the first page of a visit the site that sent the visitor
 * (domain only), the browser's language and whether this is a computer, tablet or phone. The server
 * adds the country and keeps only daily totals. Nothing is sent from the editor about documents
 * except that one was opened, saved or created (and its size range): never a name or content.
 * Off when the browser asks not to be tracked, for local copies, and when the person opts out:
 * localStorage pdfe.noStats = "1" (the privacy page has the switch). */
(function () {
  "use strict";
  const off = () => {
    try { if (localStorage.getItem("pdfe.noStats") === "1") return true; } catch (e) {}
    return navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true ||
      !/^https:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ||
      (navigator.webdriver === true && !window.PDFE_STATS_TEST);         // automated browsers (tests, bots)
  };
  const send = (body) => {
    if (off()) return;
    try {
      const data = JSON.stringify(body);
      if (navigator.sendBeacon && navigator.sendBeacon("/api/hit", new Blob([data], { type: "application/json" }))) return;
      fetch("/api/hit", { method: "POST", body: data, headers: { "Content-Type": "application/json" }, keepalive: true, credentials: "omit" }).catch(() => {});
    } catch (e) {}
  };
  // one visit = the first page this tab shows (sessionStorage is per tab and is gone when it closes)
  let first = false;
  try { first = !sessionStorage.getItem("pdfe.visit"); sessionStorage.setItem("pdfe.visit", "1"); } catch (e) {}
  const utm = new URLSearchParams(location.search).get("utm_source") || new URLSearchParams(location.search).get("ref") || "";
  const page = () => send({ t: "page", p: location.pathname, v: first ? 1 : 0, r: first ? document.referrer : "", u: first ? utm : "", l: (navigator.language || "").slice(0, 2) });
  if (document.visibilityState === "prerender") document.addEventListener("visibilitychange", page, { once: true });
  else page();

  const sizeRange = (b) => (b < 1048576 ? "<1MB" : b < 10485760 ? "1-10MB" : b < 52428800 ? "10-50MB" : "50MB+");
  const seen = new Set();
  /** count("pdf_opened", {size}) / count("tool_used", {tool: "redact"}) - at most once per tool and visit-page for tools */
  window.PDFE_STATS = {
    event(name, o = {}) {
      const key = name + ":" + (o.tool || "");
      if ((name === "text_edited" || name === "tool_used") && seen.has(key)) return;   // presence, not every click
      seen.add(key);
      send({ t: "event", e: name, x: o.tool || (o.size != null ? sizeRange(o.size) : "") });
    },
    get enabled() { return !off(); },
    set enabled(on) { try { if (on) localStorage.removeItem("pdfe.noStats"); else localStorage.setItem("pdfe.noStats", "1"); } catch (e) {} },
  };
})();
