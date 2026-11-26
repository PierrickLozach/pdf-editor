// Quicktou.ch - visit statistics (our own, no third party). The site itself is static files; this
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

import { handlePro } from "./pro.js";
import { handleAdmin } from "./admin.js";
import { same, hasSession, signIn, signOut } from "./session.js";
import { PAGES } from "./pages.gen.js";

const KINDS = {
  visit: 1, page: 1, source: 1, country: 1, lang: 1, device: 1, browser: 1, event: 1, tool: 1, size: 1, doctype: 1, docformat: 1,
};
const EVENTS = new Set(["pdf_opened", "pdf_saved", "pdf_downloaded", "pdf_created", "text_edited", "tool_used", "lib_loaded", "pro_shown", "pro_activated",
  "doc_opened", "doc_saved", "doc_downloaded", "doc_created", "doc_retry", "doc_failed"]);
const TOOLS = new Set(["sign", "redact", "ocr", "split", "convert", "protect", "numbers", "watermark", "reduce", "image", "add", "erase", "find", "delete", "batch", "smartredact", "compare", "forms", "addfield", "docedit"]);
const SIZES = new Set(["<1MB", "1-10MB", "10-50MB", "50MB+"]);
const DOCTYPES = new Set(["docx", "dotx", "odt", "ott"]);          // the kind of Word or LibreOffice file opened
const DOCFORMATS = new Set(["docx", "odt", "pdf"]);                 // what a document was downloaded as
const MAX_VALUES_PER_KIND_AND_DAY = 400;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra } });
const day = (d = new Date()) => d.toISOString().slice(0, 10);

/** A page path the site really has: "/", "/fr/", "/terms", "/de/privacy", "/app/", "/guides", "/fr/sign-pdf"
 *  (the list of pages, PAGES, is written by tools/build_site.py from the site's own pages). */
function cleanPage(p, langs) {
  try { p = new URL(String(p), "https://x").pathname; } catch (e) { return null; }
  if (p.length > 40) return null;
  const m = /^\/(?:([a-z]{2})\/)?([a-z0-9-]*)\/?$/.exec(p);
  if (!m) return null;
  const [, lang, slug] = m;
  if (lang && !langs.has(lang)) return null;
  if (!PAGES.has(slug)) return null;
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
  // the local server rewrites the request's host to the site's domain: compare by hostname, and accept
  // localhost/127.0.0.1 only there (the deployed site never sees those)
  const origin = request.headers.get("Origin");
  const sameSite = (o) => { try { const h = new URL(o).hostname; return h === url.hostname || h === "quicktou.ch" || h === "www.quicktou.ch" || h === "pdf-editor.pierrick35.workers.dev" || ((h === "localhost" || h === "127.0.0.1") && url.hostname !== "quicktou.ch" ? true : (h === "localhost" || h === "127.0.0.1") && env.LOCAL_DEV === "1"); } catch (e) { return false; } };
  if (origin && !sameSite(origin)) return new Response(null, { status: 403 });
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
    if (b.e === "doc_opened" && DOCTYPES.has(b.x)) add("doctype", b.x);
    if (b.e === "doc_downloaded" && DOCFORMATS.has(b.x)) add("docformat", b.x);
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
// the key, given once in ?key= (then a session cookie) or, for scripts, as "Authorization: Bearer <key>"
function keyGiven(request, env) {
  const key = env.STATS_KEY;
  if (!key || key.length < 16) return false;
  const url = new URL(request.url);
  return same(key, url.searchParams.get("key") || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""));
}
/** The one public figure: files (PDFs and documents) opened in the last 30 days, from the same anonymous daily
 *  totals: exact below 100, then rounded down (to 10, 100, 1,000…). Below the threshold (vars PUBLIC_MIN, 1 by
 *  default) it says nothing: {show: false}. */
async function publicFigure(env) {
  const since = day(new Date(Date.now() - 29 * 86400000));
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(n), 0) AS n FROM daily WHERE day >= ? AND kind = 'event' AND value IN ('pdf_opened', 'doc_opened')`).bind(since).first();
  const n = Number(row && row.n) || 0, min = Math.max(1, Number(env.PUBLIC_MIN) || 1);
  if (n < min) return { show: false };
  const step = n < 100 ? 1 : 10 ** (String(n).length - 2);           // 87 -> 87, 123 -> 120, 1,234 -> 1,200, 56,789 -> 56,000
  return { show: true, files30: Math.floor(n / step) * step };
}

async function figures(env, days) {
  days = Math.max(1, Math.min(Number(days) || 30, 400));
  const since = day(new Date(Date.now() - (days - 1) * 86400000));
  const prevSince = day(new Date(Date.now() - (2 * days - 1) * 86400000));          // the period before, to compare
  const { results } = await env.DB.prepare(`SELECT day, kind, value, n FROM daily WHERE day >= ? ORDER BY day`).bind(prevSince).all();
  const perDay = {}, totals = {}, before = {};
  const bump = (d, k, n) => { perDay[d] = perDay[d] || {}; perDay[d][k] = (perDay[d][k] || 0) + n; };
  for (const r of results) {
    if (r.day < since) {                                             // only the headline figures of the period before
      const k = r.kind === "visit" ? "visits" : r.kind === "event" && r.value === "pdf_opened" ? "pdfs" : r.kind === "event" && r.value === "doc_opened" ? "docs" : null;
      if (k) before[k] = (before[k] || 0) + r.n;
      continue;
    }
    if (r.kind === "visit") bump(r.day, "visits", r.n);
    if (r.kind === "page") bump(r.day, "pages", r.n);
    // files opened in the editor: PDFs, and Word or LibreOffice documents
    if (r.kind === "event" && r.value === "pdf_opened") bump(r.day, "pdfs", r.n);
    if (r.kind === "event" && r.value === "doc_opened") bump(r.day, "docs", r.n);
    totals[r.kind] = totals[r.kind] || {};
    totals[r.kind][r.value] = (totals[r.kind][r.value] || 0) + r.n;
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = day(new Date(Date.now() - i * 86400000)), x = perDay[d] || {};
    series.push({ day: d, visits: x.visits || 0, pages: x.pages || 0, pdfs: x.pdfs || 0, docs: x.docs || 0 });
  }
  const top = (k, n = 15) => Object.entries(totals[k] || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  // pages counted once whatever their language ("/", "/fr/", "/de/" are all the home page)
  const pageGroups = {};
  for (const [path, n] of Object.entries(totals.page || {})) {
    const slug = path.replace(/^\/(?:[a-z]{2}\/)?/, "").replace(/\/$/, "");
    pageGroups[slug] = (pageGroups[slug] || 0) + n;
  }
  const siteLangs = {};
  for (const [path, n] of Object.entries(totals.page || {})) {
    const m = /^\/([a-z]{2})\//.exec(path), slug = path.replace(/^\/(?:[a-z]{2}\/)?/, "").replace(/\/$/, "");
    if (slug === "app") continue;                                 // the editor's address has no language
    const l = m ? m[1] : "en";
    siteLangs[l] = (siteLangs[l] || 0) + n;
  }
  const sorted = (o, n = 20) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { days, since, series, before, visits: (totals.visit || {}).all || 0, events: totals.event || {},
    pages: sorted(pageGroups), pagePaths: top("page", 40), siteLanguages: sorted(siteLangs), sources: top("source", 20), countries: top("country", 30),
    languages: top("lang"), devices: top("device"), browsers: top("browser"), tools: top("tool", 30), sizes: top("size"),
    docTypes: top("doctype"), docFormats: top("docformat") };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COUNTRY = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) { return null; } })();
const LANGUAGE = (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }); } catch (e) { return null; } })();
const PAGE_NAMES = { "": "Home page", app: "Editor", about: "About", contact: "Contact", guides: "Guides (list)", "whats-new": "What's new",
  privacy: "Privacy", cookies: "Cookies", terms: "Terms of use", legal: "Legal notice", sales: "Terms of sale", developers: "For developers",
  "edit-pdf-text": "Guide: change the text of a PDF", "sign-pdf": "Guide: sign a PDF", "redact-pdf": "Guide: redact a PDF",
  "ocr-pdf": "Guide: make a scan searchable", "reduce-pdf-size": "Guide: make a PDF smaller", "organise-pdf-pages": "Guide: merge, split, reorder",
  "check-pdf-privacy": "Guide: check an online PDF tool" };
const TOOL_NAMES = { sign: "Sign", redact: "Redact", ocr: "Make searchable (OCR)", split: "Split or extract pages", convert: "Convert",
  docedit: "Convert › Edit as a document", protect: "Protect with a password", numbers: "Page numbers", watermark: "Watermark",
  reduce: "Reduce file size", image: "Add an image", add: "Add text", erase: "Whiteout", find: "Find & replace", delete: "Delete an item",
  batch: "Pro: batch", smartredact: "Pro: smart redaction", compare: "Pro: compare PDFs", forms: "Pro: forms", addfield: "Pro: add a form field" };
const DOCTYPE_NAMES = { docx: "Word (.docx)", dotx: "Word template (.dotx)", odt: "LibreOffice (.odt)", ott: "LibreOffice template (.ott)" };
const DOCFORMAT_NAMES = { docx: "Word (.docx)", odt: "LibreOffice (.odt)", pdf: "PDF" };
const SOURCE_NAMES = { direct: "Direct (typed, bookmark, app)", other: "Other sites" };

function page(f) {
  const ev = (k) => f.events[k] || 0;
  const n = (v) => Number(v || 0).toLocaleString("en");
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + " %" : "–");
  const sum = (k) => f.series.reduce((a, s) => a + s[k], 0);
  const today = f.series[f.series.length - 1];
  const change = (now, was) => {
    if (!was) return now ? `nothing in the ${f.days} days before` : "";
    const d = Math.round(((now - was) / was) * 100);
    return `<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d} %</span> vs the ${f.days} days before`;
  };
  // one chart: visits as a line of bars; files opened per day, PDFs and documents stacked
  const chart = (rows, title) => {
    const max = Math.max(1, ...f.series.map((s) => rows.reduce((a, r) => a + s[r.k], 0)));
    const w = 100 / f.series.length;
    const bars = f.series.map((s, i) => {
      let y = 100;
      return rows.map((r) => {
        const h = (s[r.k] / max) * 100; y -= h;
        return h ? `<rect class="${r.c}" x="${(i * w).toFixed(2)}%" y="${y.toFixed(2)}%" width="${(w * 0.8).toFixed(2)}%" height="${h.toFixed(2)}%"><title>${s.day}: ${rows.map((q) => `${n(s[q.k])} ${q.label.toLowerCase()}`).join(", ")}</title></rect>` : "";
      }).join("");
    }).join("");
    return `<figure><figcaption>${esc(title)} <span class="legend">${rows.map((r) => `<i class="${r.c}"></i>${esc(r.label)}`).join(" ")}</span> <span class="small">· highest day: ${n(max)}</span></figcaption>
<svg role="img" aria-label="${esc(title)}" viewBox="0 0 100 100" preserveAspectRatio="none">${bars}</svg>
<div class="axis"><span>${esc(f.series[0].day)}</span><span>${esc(today.day)}</span></div></figure>`;
  };
  const table = (title, rows, label = (v) => v, total) => {
    const all = total || rows.reduce((a, [, v]) => a + v, 0);
    return `<section><h2>${esc(title)}</h2>${rows.length ? `<table>${rows.map(([v, c]) => `<tr><td>${esc(label(v))}</td><td>${n(c)}</td><td class="pc">${all ? Math.round((c / all) * 100) + " %" : ""}</td></tr>`).join("")}</table>` : `<p class="none">Nothing yet.</p>`}</section>`;
  };
  const list = (title, items, note = "") => `<section><h2>${esc(title)}</h2><table>${items.map(([label, v, extra]) => `<tr><td>${esc(label)}</td><td>${n(v)}</td><td class="pc">${extra || ""}</td></tr>`).join("")}</table>${note ? `<p class="small">${note}</p>` : ""}</section>`;
  const opts = [7, 30, 90, 365].map((d) => `<a href="?days=${d}"${d === f.days ? ' aria-current="page"' : ""}>${d} days</a>`).join("");
  const pdfs = sum("pdfs"), docs = sum("docs"), files = pdfs + docs;
  const pdfKept = ev("pdf_saved") + ev("pdf_downloaded"), docKept = ev("doc_saved") + ev("doc_downloaded");
  const proSeen = ev("pro_shown") + ev("pro_activated") + f.tools.filter(([t]) => /^(batch|smartredact|compare|forms|addfield)$/.test(t)).length;
  const pdfTools = f.tools.filter(([t]) => t !== "docedit");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Statistics – Quicktou.ch</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2129;--muted:#6b7280;--line:#e3e6ea;--card:#f7f8fa;--accent:#e5322d;--doc:#2f6fdb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8eaed;--muted:#9aa0a6;--line:#30343a;--card:#1c1f23;--doc:#6ea0ff;--ok:#4ade80;--bad:#f87171}}
body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:1150px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
h3{font-size:16px;margin:30px 0 4px}
.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}.k div{background:var(--card);border-radius:12px;padding:14px}
.k b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.k span{color:var(--muted);font-size:13px;display:block}.k .pdf b{color:var(--accent)}.k .doc b{color:var(--doc)}
.up{color:var(--ok)}.down{color:var(--bad)}
figure{margin:0 0 16px}figcaption{font-weight:600;margin-bottom:6px}.legend{font-weight:400;font-size:13px;color:var(--muted);margin-left:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}
svg{width:100%;height:150px;background:var(--card);border-radius:12px;display:block}rect:hover{opacity:.7}
.v,.legend i.v{fill:#8b93a1;background:#8b93a1}.p,.legend i.p{fill:var(--accent);background:var(--accent)}.d,.legend i.d{fill:var(--doc);background:var(--doc)}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:3px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;margin-top:10px}section{background:var(--card);border-radius:12px;padding:14px}
table{width:100%;border-collapse:collapse}td{padding:4px 0;border-bottom:1px solid var(--line)}td:nth-child(2){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.pc{width:56px;text-align:right;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.none{color:var(--muted)}nav a{margin-right:12px;color:var(--fg)}nav a[aria-current]{font-weight:700;color:var(--accent)}.small{color:var(--muted);font-size:13px}
.warn{color:var(--bad)}
</style></head><body><main>
<h1>Quicktou.ch – statistics</h1><p class="small">Totals per day, without cookies or personal data. Since ${esc(f.since)}. Times in UTC.</p>
<nav>${opts}</nav>
<div class="k">
<div><b>${n(sum("visits"))}</b><span>visits</span><span>${change(sum("visits"), f.before.visits)}</span></div>
<div><b>${n(sum("pages"))}</b><span>pages viewed</span><span>${sum("visits") ? (sum("pages") / sum("visits")).toFixed(1) + " per visit" : ""}</span></div>
<div class="pdf"><b>${n(pdfs)}</b><span>PDFs opened</span><span>${change(pdfs, f.before.pdfs)}</span></div>
<div class="doc"><b>${n(docs)}</b><span>Word or LibreOffice documents opened</span><span>${change(docs, f.before.docs)}</span></div>
<div><b>${n(today.visits)}</b><span>visits today</span><span>${n(today.pdfs)} PDFs, ${n(today.docs)} documents</span></div>
</div>
${chart([{ k: "visits", c: "v", label: "Visits" }], "Visits per day")}
${chart([{ k: "pdfs", c: "p", label: "PDFs" }, { k: "docs", c: "d", label: "Documents" }], "Files opened per day")}
<p class="small">Files opened: ${n(files)} · ${pct(pdfs, files)} PDFs, ${pct(docs, files)} Word or LibreOffice documents.</p>

<h3>PDFs</h3><div class="grid">
${list("What people do with PDFs", [
  ["Opened", ev("pdf_opened")],
  ["Text edited", ev("text_edited"), pct(ev("text_edited"), ev("pdf_opened"))],
  ["Saved into the file", ev("pdf_saved"), pct(ev("pdf_saved"), ev("pdf_opened"))],
  ["Downloaded", ev("pdf_downloaded"), pct(ev("pdf_downloaded"), ev("pdf_opened"))],
  ["Created from pictures", ev("pdf_created")],
], `Saved or downloaded: ${n(pdfKept)} (${pct(pdfKept, ev("pdf_opened"))} of the PDFs opened). Percentages are of the PDFs opened.`)}
${table("Tools used (% of the PDFs opened)", pdfTools, (v) => TOOL_NAMES[v] || v, ev("pdf_opened"))}
${table("Size of the PDFs opened", f.sizes)}
</div>

<h3>Word and LibreOffice documents</h3><div class="grid">
${list("What people do with documents", [
  ["Opened", ev("doc_opened")],
  ["Saved into the file", ev("doc_saved"), pct(ev("doc_saved"), ev("doc_opened"))],
  ["Downloaded", ev("doc_downloaded"), pct(ev("doc_downloaded"), ev("doc_opened"))],
  ["New document", ev("doc_created")],
  ["From a PDF (Convert › Edit as a document)", (f.tools.find(([t]) => t === "docedit") || [0, 0])[1]],
], `Saved or downloaded: ${n(docKept)} (${pct(docKept, ev("doc_opened"))} of the documents opened). Percentages are of the documents opened.`)}
${table("Kind of document opened", f.docTypes, (v) => DOCTYPE_NAMES[v] || v)}
${table("Downloaded as", f.docFormats, (v) => DOCFORMAT_NAMES[v] || v)}
${list("Word processor problems", [
  ["Restarted because it did not answer", ev("doc_retry"), ev("doc_retry") ? `<span class="warn">${pct(ev("doc_retry"), ev("doc_opened"))}</span>` : ""],
  ["Could not open a document", ev("doc_failed"), ev("doc_failed") ? `<span class="warn">!</span>` : ""],
], "A restart happens when the word processor does not answer within 15 seconds; the document is then opened by a new one. Percentage: of the documents opened.")}
</div>

<h3>Visitors</h3><div class="grid">
${table("Where visitors come from", f.sources, (v) => SOURCE_NAMES[v] || (v.startsWith("campaign:") ? "Campaign: " + v.slice(9) : v))}
${table("Countries", f.countries, (v) => (v === "unknown" ? "Unknown" : (COUNTRY && COUNTRY.of(v)) || v))}
${table("Pages (all languages)", f.pages, (v) => PAGE_NAMES[v] ?? v)}
${table("Language of the pages read", f.siteLanguages, (v) => (LANGUAGE && LANGUAGE.of(v)) || v)}
${table("Language of the browser", f.languages, (v) => (v === "other" ? "Other" : (LANGUAGE && LANGUAGE.of(v)) || v))}
${table("Devices", f.devices, (v) => ({ computer: "Computer", phone: "Phone", tablet: "Tablet" }[v] || v))}
${table("Browsers", f.browsers)}
</div>

<h3>Other</h3><div class="grid">
${list("Developers", [["JavaScript library loaded", ev("lib_loaded")]])}
${proSeen ? list("Pro", [["Pro window shown", ev("pro_shown")], ["Licence activated", ev("pro_activated")]]) : ""}
</div>
<p class="small">JSON: <code>/api/stats.json?days=${f.days}</code> (signed in, or with <code>Authorization: Bearer &lt;key&gt;</code>). <a href="?signout">Sign out</a></p></main></body></html>`;
}

const CANONICAL_HOST = "quicktou.ch";
// the old workers.dev address and www: one permanent redirect to the same page on the domain
const OLD_HOSTS = new Set(["pdf-editor.pierrick35.workers.dev", "www." + CANONICAL_HOST]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.REDIRECT_OLD === "1" && OLD_HOSTS.has(url.hostname) && !url.pathname.startsWith("/api/")) {   // switched on once the domain is active
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.href, 301);
    }
    if (url.pathname.startsWith("/api/pro/")) {
      try { return await handlePro(request, env, url.pathname); }
      catch (e) { return new Response(JSON.stringify({ error: "The licence could not be checked just now. Try again in a moment." }), { status: 503, headers: { "Content-Type": "application/json" } }); }
    }
    if (url.pathname === "/api/admin") {
      try { return await handleAdmin(request, env); }
      catch (e) { return new Response("Error: " + (e && e.message), { status: 500, headers: { "Content-Type": "text/plain" } }); }
    }
    try {
      if (url.pathname === "/api/hit") {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        return await hit(request, env);
      }
      if (url.pathname === "/api/public.json") {                    // the home page's counter: one rounded total, cached
        if (request.method !== "GET") return new Response(null, { status: 405 });
        const r = json(await publicFigure(env));
        r.headers.set("Cache-Control", "public, max-age=3600");
        return r;
      }
      if (url.pathname === "/api/stats" || url.pathname === "/api/stats.json") {
        const notFound = () => env.ASSETS.fetch(new Request(new URL("/__not_found__", request.url)));   // the site's ordinary 404 page, as for any missing address   // looks absent
        const bearer = /^Bearer\s/i.test(request.headers.get("Authorization") || "");
        if (url.searchParams.has("key")) {
          if (!keyGiven(request, env)) return notFound();
          if (url.pathname === "/api/stats") return signIn(request, "stats", env.STATS_KEY);   // once: then the address has no key
        } else if (bearer ? !keyGiven(request, env) : !(await hasSession(request, "stats", env.STATS_KEY))) return notFound();
        if (url.searchParams.has("signout")) return signOut(request, "stats");
        const f = await figures(env, url.searchParams.get("days"));
        if (url.pathname.endsWith(".json")) { const r = json(f); r.headers.set("Cache-Control", "no-store"); return r; }
        return new Response(page(f), { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "Referrer-Policy": "no-referrer" } });
      }
    } catch (e) {
      return new Response(null, { status: 204 });                 // counting must never get in the way
    }
    // Word and LibreOffice documents open in the one editor (/app/); /write/ was their own page for a day
    if (url.pathname === "/write" || url.pathname.startsWith("/write/")) return Response.redirect(new URL("/app/", url).href, 301);
    // the word processor is shown inside the editor; opened on its own it would be EdenText's full app
    // (its own storage, none of the editor's file handling): back to the editor
    if ((url.pathname === "/app/edentext/" || url.pathname === "/app/edentext/index.html") && request.headers.get("Sec-Fetch-Dest") === "document")
      return Response.redirect(new URL("/app/", url).href, 302);
    if (url.pathname.endsWith(".mp4")) return ranged(request, await env.ASSETS.fetch(request));
    return env.ASSETS.fetch(request);
  },
};

// Static assets ignore Range requests, and Safari (Mac, iPhone, iPad) plays a video only when the server
// answers them with 206 Partial Content: the landing page video gets its byte ranges here.
async function ranged(request, res) {
  if (res.status !== 200) return res;
  const h = new Headers(res.headers);
  h.set("Accept-Ranges", "bytes");
  const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("Range") || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return new Response(res.body, { status: 200, headers: h });   // no range (or several): the whole file
  const buf = await res.arrayBuffer(), size = buf.byteLength;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }                       // bytes=-500: the last 500
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) { h.set("Content-Range", `bytes */${size}`); h.delete("Content-Length"); return new Response(null, { status: 416, headers: h }); }
  h.set("Content-Range", `bytes ${start}-${end}/${size}`);
  h.set("Content-Length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : buf.slice(start, end + 1), { status: 206, headers: h });
}
