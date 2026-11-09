/* PDF Editor - interface translations.
 * The interface is written in English; this script shows it in the user's language by replacing
 * the texts on the page with those of i18n/<lang>.json, including the texts that appear later
 * (messages, windows). Right-to-left languages mirror the layout (the PDF pages never mirror).
 *
 * Add a language: create i18n/<code>.json (same keys as fr.json) and add a line to LANGS below.
 * Dictionary format:
 *   "strings":  { "English text": "translation" }                       exact texts
 *   "patterns": [ ["Delete page {n}?", "Supprimer la page {n} ?"] ]     texts with variable parts
 * A text made of parts joined by " · " is translated part by part. Loaded as a classic script,
 * first in <head>, so the page is shown already translated. */
(function () {
  "use strict";
  const LANGS = [
    ["en", "English", "ltr"],
    ["fr", "Français", "ltr"],
  ];
  const KEY = "pdfe.lang";
  const extra = (window.PDFE_EXTRA_LANGS || []);          // tests can add languages (right-to-left checks)
  const all = LANGS.concat(extra);
  const known = (c) => all.find((l) => l[0] === c);
  function pick() {
    const q = new URLSearchParams(location.search).get("lang");
    if (q && known(q)) { try { localStorage.setItem(KEY, q); } catch (e) {} return q; }
    try { const s = localStorage.getItem(KEY); if (s && known(s)) return s; } catch (e) {}
    const site = document.documentElement.getAttribute("data-site-lang");
    if (site && known(site)) return site;
    for (const l of navigator.languages || [navigator.language || "en"]) {
      const c = String(l).toLowerCase().split("-")[0];
      if (known(c)) return c;
    }
    return "en";
  }
  const lang = pick(), info = known(lang);
  const root = document.documentElement;
  root.lang = lang;
  root.dir = info[2];

  const I18N = (window.I18N = { lang, dir: info[2], languages: all.map(([code, name, dir]) => ({ code, name, dir })), t: (s) => s, ready: Promise.resolve() });
  I18N.set = (code) => { try { localStorage.setItem(KEY, code); } catch (e) {} location.reload(); };
  if (lang === "en") return;

  /* ---------------------------------------------------------------- dictionary */
  const strings = new Map(), patterns = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function load(d) {
    for (const [k, v] of Object.entries(d.strings || {})) strings.set(k, v);
    for (const [src, dst] of d.patterns || []) {
      const names = [];
      const rx = new RegExp("^" + esc(src).replace(/\\\{(\w+)\\\}/g, (m, n) => { names.push(n); return "([\\s\\S]+?)"; }) + "$");
      patterns.push({ rx, names, dst });
    }
  }
  function tr(text) {
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    const core = text.slice(lead.length, text.length - trail.length);
    if (!core || !/[A-Za-z]/.test(core)) return text;
    const one = (s) => {
      if (strings.has(s)) return strings.get(s);
      for (const p of patterns) {
        const m = s.match(p.rx);
        if (m) return p.dst.replace(/\{(\w+)\}/g, (x, n) => { const v = m[p.names.indexOf(n) + 1]; return v === undefined ? x : (strings.get(v) || v); });
      }
      return null;
    };
    let out = one(core);
    if (out === null && core.includes(" · ")) {           // "Saved · 2 skipped" → part by part
      const parts = core.split(" · ").map((p) => one(p) ?? p);
      out = parts.join(" · ");
      if (out === core) out = null;
    }
    return out === null ? text : lead + out + trail;
  }
  I18N.t = (s) => tr(String(s));

  /* ---------------------------------------------------------------- the page */
  const SKIP = ".editbox, #docName, [data-noi18n], script, style, code, kbd, #fontList .nm";
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  const done = new WeakMap();                               // text node -> the text we wrote
  function textNode(n) {
    const v = n.nodeValue;
    if (done.get(n) === v) return;
    const p = n.parentElement;
    if (!p || p.closest(SKIP)) return;
    const t = tr(v);
    done.set(n, t);
    if (t !== v) n.nodeValue = t;
  }
  function element(el) {
    if (el.closest && el.closest(SKIP)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && /[A-Za-z]/.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
    }
    if (el.tagName === "OPTGROUP" && el.label) { const t = tr(el.label); if (t !== el.label) el.label = t; }
  }
  function walk(node) {
    if (node.nodeType === 3) return textNode(node);
    if (node.nodeType !== 1) return;
    element(node);
    const it = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) n.nodeType === 3 ? textNode(n) : element(n);
  }
  let title = null;
  const fixTitle = () => { if (document.title !== title) { title = tr(document.title); if (title !== document.title) document.title = title; } };

  root.classList.add("i18n-wait");
  const base = (document.currentScript && document.currentScript.src) || location.href;
  const ver = new URL(base, location.href).searchParams.get("v");
  I18N.ready = fetch(new URL(`i18n/${lang}.json${ver ? "?v=" + ver : ""}`, base))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((d) => {
      load(d);
      const start = () => {
        walk(document.body);
        fixTitle();
        new MutationObserver((list) => {
          for (const m of list) {
            if (m.type === "characterData") textNode(m.target);
            else if (m.type === "attributes") element(m.target);
            else for (const n of m.addedNodes) walk(n);
          }
          fixTitle();
        }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(["label"]) });
        root.classList.remove("i18n-wait");
      };
      if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
    });
  setTimeout(() => root.classList.remove("i18n-wait"), 2500);   // never leave the page hidden
})();
