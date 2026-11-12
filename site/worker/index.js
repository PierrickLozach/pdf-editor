// PDF Editor - visit statistics (our own, no third party). The site itself is static files; this
// Worker only answers /api/*:
//   POST /api/hit    from the site's pages: counts one event in a daily total
//   GET  /api/stats  the statistics page (needs the key set with `wrangler secret put STATS_KEY`)
//   GET  /api/stats.json?days=30   the same figures as JSON
//
// What is stored: per day, totals of {kind, value} - for example ("page", "/fr/"), ("source",
// "google.com"), ("country", "FR"), ("event", "pdf_opened"). Nothing else: no IP address, no cookie,
// no identifier, no user agent, no file name, no time of day. A "visit" is the first page a browser
// tab shows (the page tells it, from sessionStorage); it cannot be linked to another visit.
// Limits keep the table small: only known pages and events are counted, a source is reduced to a
// domain name, at most a few hundred distinct values per kind and day. Nothing is counted when the
// browser asks not to be tracked (Do Not Track / Global Privacy Control) or the person opts out.

const KINDS = {
  visit: 1, page: 1, source: 1, country: 1, lang: 1, device: 1, browser: 1, event: 1, tool: 1, size: 1,
};
const EVENTS = new Set(["pdf_opened", "pdf_saved", "pdf_downloaded", "pdf_created", "text_edited", "tool_used", "lib_loaded"]);
const TOOLS = new Set(["sign", "redact", "ocr", "split", "convert", "protect", "numbers", "watermark", "reduce", "image", "add", "erase", "find", "delete"]);
const SIZES = new Set(["<1MB", "1-10MB", "10-50MB", "50MB+"]);
const MAX_VALUES_PER_KIND_AND_DAY = 400;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } });
const day = (d = new Date()) => d.toISOString().slice(0, 10);

/** A page path the site really has: "/", "/fr/", "/terms", "/de/privacy", "/app/", "/developers". */
function cleanPage(p, langs) {
  try { p = new URL(String(p), "https://x").pathname; } catch (e) { return null; }
  if (p.length > 40) return null;
  const m = /^\/(?:([a-z]{2})\/)?([a-z0-9-]*)\/?$/.exec(p);
  if (!m) return null;
  const [, lang, slug] = m;
  if (lang && !langs.has(lang)) return null;
  if (!["", "app", "privacy", "cookies", "terms", "legal", "developers"].includes(slug)) return null;
  return (lang ? `/${lang}/` : "/") + (slug ? slug + (slug === "app" ? "/" : "") : "");
}
/** Where the visitor came from, reduced to a domain ("google.com"), or a campaign name. */
function cleanSource(ref, utm, ownHost) {
  if (utm && /^[\w.-]{1,40}$/.test(utm)) return "campaign:" + utm.toLowerCase();
  if (!ref) return "direct";
  let h;
  try { h = new URL(ref).hostname.toLowerCase(); } catch (e) { return "other"; }
  if (!h || h === ownHost) return null;                        // a page of this site: not a source
  h = h.replace(/^(www|m|l|lm|mobile|amp)\./, "");
  const two = h.split(".").slice(-2).join(".");
  // well-known groups (country versions of search engines and social networks)
  if (/(^|\.)google\./.test(h)) return "google";
  if (/(^|\.)bing\.com$/.test(h)) return "bing";
  if (/(^|\.)duckduckgo\.com$/.test(h)) return "duckduckgo";
  if (/(^|\.)(facebook|fb)\.com$/.test(h)) return "facebook";
  if (/(^|\.)(t\.co|twitter\.com|x\.com)$/.test(h)) return "x.com";
  if (/(^|\.)linkedin\.com$/.test(h)) return "linkedin";
  if (/(^|\.)reddit\.com$/.test(h)) return "reddit";
  if (/(^|\.)github\.com$/.test(h)) return "github";
  return /^[a-z0-9.-]{3,60}$/.test(two) ? two : "other";
}
function device(ua) {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(ua)) return "phone";
  return "computer";
}
function browser(ua) {
  if (/Edg\//.test(ua)) return "Edge";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "other";
}

async function hit(request, env) {
  const url = new URL(request.url);
  // only from this site's own pages, never cross-site; honour the browser's privacy signals
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response(null, { status: 403 });
  if (request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1") return new Response(null, { status: 204 });
  const ua = request.headers.get("User-Agent") || "";
  if (/bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|monitor/i.test(ua) || /PDFE-Test/.test(ua)) return new Response(null, { status: 204 });
  let b;
  try { b = await request.json(); } catch (e) { return new Response(null, { status: 400 }); }
  if (!b || typeof b !== "object" || JSON.stringify(b).length > 600) return new Response(null, { status: 400 });
  const langs = new Set(String(env.LANGS || "en").split(","));
  const rows = [];
  const add = (kind, value) => { if (value && KINDS[kind]) rows.push([kind, String(value).slice(0, 60)]); };
  if (b.t === "page") {
    const page = cleanPage(b.p, langs);
    if (!page) return new Response(null, { status: 204 });
    add("page", page);
    if (b.v === 1) {                                               // first page of a visit
      add("visit", "all");
      add("source", cleanSource(b.r, b.u, url.hostname));
      const c = request.cf && request.cf.country;
      add("country", /^[A-Z]{2}$/.test(c || "") ? c : "unknown");
      const l = String(b.l || "").slice(0, 2).toLowerCase();
      add("lang", /^[a-z]{2}$/.test(l) ? l : "other");
      add("device", device(ua));
      add("browser", browser(ua));
    }
  } else if (b.t === "event") {
    if (!EVENTS.has(b.e)) return new Response(null, { status: 204 });
    add("event", b.e);
    if (b.e === "tool_used" && TOOLS.has(b.x)) add("tool", b.x);
    if (b.e === "pdf_opened" && SIZES.has(b.x)) add("size", b.x);
  } else return new Response(null, { status: 400 });
  const d = day();
  const stmts = [];
  for (const [kind, value] of rows) {
    if (kind === "source" || kind === "country") {
      // a new value is accepted only while the day has room for it (keeps the table small)
      stmts.push(env.DB.prepare(
        `INSERT INTO daily (day, kind, value, n) SELECT ?1, ?2, ?3, 1
           WHERE EXISTS (SELECT 1 FROM daily WHERE day = ?1 AND kind = ?2 AND value = ?3)
              OR (SELECT COUNT(*) FROM daily WHERE day = ?1 AND kind = ?2) < ${MAX_VALUES_PER_KIND_AND_DAY}
         ON CONFLICT (day, kind, value) DO UPDATE SET n = n + 1`).bind(d, kind, value));
    } else {
      stmts.push(env.DB.prepare(`INSERT INTO daily (day, kind, value, n) VALUES (?1, ?2, ?3, 1)
         ON CONFLICT (day, kind, value) DO UPDATE SET n = n + 1`).bind(d, kind, value));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return new Response(null, { status: 204 });
}

/* ---------------------------------------------------------------- the statistics */
function authorised(request, env) {
  const key = env.STATS_KEY;
  if (!key || key.length < 16) return false;
  const url = new URL(request.url);
  const given = url.searchParams.get("key") || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);   // constant time
  return diff === 0;
}
async function figures(env, days) {
  days = Math.max(1, Math.min(Number(days) || 30, 400));
  const since = day(new Date(Date.now() - (days - 1) * 86400000));
  const { results } = await env.DB.prepare(`SELECT day, kind, value, n FROM daily WHERE day >= ? ORDER BY day`).bind(since).all();
  const perDay = {}, totals = {};
  for (const r of results) {
    if (r.kind === "visit") perDay[r.day] = { ...(perDay[r.day] || {}), visits: (perDay[r.day]?.visits || 0) + r.n };
    if (r.kind === "page") perDay[r.day] = { ...(perDay[r.day] || {}), pages: (perDay[r.day]?.pages || 0) + r.n };
    if (r.kind === "event" && r.value === "pdf_opened") perDay[r.day] = { ...(perDay[r.day] || {}), pdfs: (perDay[r.day]?.pdfs || 0) + r.n };
    totals[r.kind] = totals[r.kind] || {};
    totals[r.kind][r.value] = (totals[r.kind][r.value] || 0) + r.n;
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const d = day(new Date(Date.now() - i * 86400000)); series.push({ day: d, visits: perDay[d]?.visits || 0, pages: perDay[d]?.pages || 0, pdfs: perDay[d]?.pdfs || 0 }); }
  const top = (k, n = 15) => Object.entries(totals[k] || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { days, since, series, visits: (totals.visit || {}).all || 0,
    pages: top("page", 20), sources: top("source", 20), countries: top("country", 30), languages: top("lang"), devices: top("device"),
    browsers: top("browser"), events: top("event"), tools: top("tool"), sizes: top("size") };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COUNTRY = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) { return null; } })();
function page(f, key) {
  const max = Math.max(1, ...f.series.map((s) => s.visits));
  const bars = f.series.map((s, i) => {
    const h = Math.round((s.visits / max) * 100), x = i * (100 / f.series.length);
    return `<rect x="${x.toFixed(2)}%" y="${100 - h}%" width="${(100 / f.series.length * 0.8).toFixed(2)}%" height="${h}%"><title>${s.day}: ${s.visits} visits, ${s.pages} pages, ${s.pdfs} PDFs</title></rect>`;
  }).join("");
  const table = (title, rows, label = (v) => v) => `<section><h2>${esc(title)}</h2>${rows.length ? `<table>${rows.map(([v, n]) => `<tr><td>${esc(label(v))}</td><td>${n.toLocaleString("en")}</td></tr>`).join("")}</table>` : `<p class="none">Nothing yet.</p>`}</section>`;
  const sum = (k) => f.series.reduce((a, s) => a + s[k], 0);
  const today = f.series[f.series.length - 1];
  const opts = [7, 30, 90, 365].map((d) => `<a href="?key=${encodeURIComponent(key)}&days=${d}"${d === f.days ? ' aria-current="page"' : ""}>${d} days</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Statistics – PDF Editor</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2129;--muted:#6b7280;--line:#e3e6ea;--card:#f7f8fa;--accent:#e5322d}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8eaed;--muted:#9aa0a6;--line:#30343a;--card:#1c1f23}}
body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}.k div{background:var(--card);border-radius:12px;padding:14px}.k b{display:block;font-size:26px}.k span{color:var(--muted);font-size:13px}
svg{width:100%;height:160px;background:var(--card);border-radius:12px;display:block}rect{fill:var(--accent)}rect:hover{opacity:.7}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;margin-top:22px}section{background:var(--card);border-radius:12px;padding:14px}
table{width:100%;border-collapse:collapse}td{padding:4px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.none{color:var(--muted)}nav a{margin-right:12px;color:var(--fg)}nav a[aria-current]{font-weight:700;color:var(--accent)}.small{color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>PDF Editor – statistics</h1><p class="small">Totals per day, without cookies or personal data. Since ${esc(f.since)}. Times in UTC.</p>
<nav>${opts}</nav>
<div class="k"><div><b>${sum("visits").toLocaleString("en")}</b><span>visits</span></div><div><b>${sum("pages").toLocaleString("en")}</b><span>pages viewed</span></div>
<div><b>${sum("pdfs").toLocaleString("en")}</b><span>PDFs opened</span></div><div><b>${today.visits.toLocaleString("en")}</b><span>visits today</span></div></div>
<svg role="img" aria-label="Visits per day" viewBox="0 0 100 100" preserveAspectRatio="none">${bars}</svg>
<div class="grid">
${table("Where visitors come from", f.sources, (v) => v === "direct" ? "Direct (typed, bookmark, app)" : v)}
${table("Countries", f.countries, (v) => (v === "unknown" ? "Unknown" : (COUNTRY && COUNTRY.of(v)) || v))}
${table("Pages", f.pages)}
${table("What people do", f.events, (v) => ({ pdf_opened: "PDF opened", pdf_saved: "PDF saved into its file", pdf_downloaded: "PDF downloaded", pdf_created: "PDF created from pictures", text_edited: "Text edited", tool_used: "Tool used", lib_loaded: "Developer library loaded" }[v] || v))}
${table("Tools", f.tools)}
${table("Languages", f.languages)}
${table("Devices", f.devices)}
${table("Browsers", f.browsers)}
${table("Size of the PDFs opened", f.sizes)}
</div><p class="small">JSON: <code>/api/stats.json?days=${f.days}</code> with the same key.</p></main></body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/hit") {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        return await hit(request, env);
      }
      if (url.pathname === "/api/stats" || url.pathname === "/api/stats.json") {
        if (!authorised(request, env)) return new Response("Not found", { status: 404 });   // looks absent without the key
        const f = await figures(env, url.searchParams.get("days"));
        if (url.pathname.endsWith(".json")) return json(f);
        return new Response(page(f, url.searchParams.get("key") || ""), { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "Referrer-Policy": "no-referrer" } });
      }
    } catch (e) {
      return new Response(null, { status: 204 });                 // counting must never get in the way
    }
    return env.ASSETS.fetch(request);
  },
};
