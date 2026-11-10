// The editor in other languages, in Chromium, Firefox and WebKit:
//  - French: every visible text of the main screens is translated, messages too, editing works
//  - right-to-left: a test language ("rtl", never published) mirrors the interface but not the PDF
// Run (editor served on 8766 or the site on 8787): node i18n.pw.mjs [chromium|firefox|webkit|all] [url]
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";

const URL0 = process.argv[3] || "http://127.0.0.1:8766/";
const which = process.argv[2] || "all";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;     // fictional invoice
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;

// visible texts with English words left (the PDF, file and font names excepted)
const english = () => {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.nodeValue.trim(), el = n.parentElement;
    if (!t || !/[A-Za-z]{3}/.test(t) || el.closest("script,style,.editbox,#docName,#fontList,[data-noi18n],select,option,#edInfo")) continue;
    if (el.closest("[hidden]") || !el.getClientRects().length) continue;
    if (/^(MuPDF|PDF|Image|Pages|OK|Polices|Google Fonts…\)?|Arial|Calibri)$/.test(t)) continue;
    out.push(t);
  }
  return out.filter((t) => /\b(the|and|your|this|with|text|to|of|font|fonts|page|click|drag|file|edit|open|save)\b/i.test(t));
};

async function run(name) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await { chromium, firefox, webkit }[name].launch();
  const waitFn = async (page, expr, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(100); }
    return false;
  };
  const errs = [];
  try {
    // ---------------------------------------------------------------- French
    const ctx = await browser.newContext({ locale: "fr-FR", viewport: { width: 1400, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/downloadable font|Refused to apply a stylesheet/.test(m.text())) errs.push(m.text()); });
    await p.goto(URL0);
    await waitFn(p, `document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait')`, 60000);
    ok((await p.getAttribute("html", "lang")) === "fr" && /Éditeur PDF/.test(await p.title()), "French from the browser's language (lang=fr, title)");
    let left = await p.evaluate(english);
    ok(!left.length, "start screen fully in French " + left.slice(0, 4).join(" | "));
    await p.evaluate(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); return call("discard"); });
    await p.setInputFiles("#fileInput", pdf);
    await waitFn(p, `S.doc && S.spans[S.doc.pages[0].v] && pageEl(0).dataset.rkey`);
    left = await p.evaluate(english);
    ok(!left.length, "editor with a PDF fully in French " + left.slice(0, 4).join(" | "));
    const titles = await p.evaluate(() => [...document.querySelectorAll("#toolbar [title]")].map((b) => b.title).filter((t) => /\b(the|and|to|of|click)\b/.test(t)));
    ok(!titles.length, "button tooltips in French " + titles.slice(0, 3).join(" | "));
    // a click on text: editor bar in French
    const sp = await p.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === "14 Harbour Street"); const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 5) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
    await p.mouse.click(sp.x, sp.y);
    await waitFn(p, `S.ed && document.activeElement === S.ed.box`);
    ok(/appliquer/.test(await p.textContent("#edInfo")) && (await p.textContent("#edApply")) === "Appliquer", "text editor bar in French");
    await p.keyboard.press("End"); await p.keyboard.type(" bis"); await p.keyboard.press("Enter");
    await waitFn(p, `!S.ed && !S.pending`);
    ok(await p.evaluate(() => call("find", "14 Harbour Street bis").then((h) => h.length === 1)), "editing works in French (the PDF text itself is never translated)");
    // find & replace counter, a confirmation window, a message
    await p.click("#btnFind"); await p.fill("#findInput", "2026"); await sleep(500);
    ok(/^1 sur 2$/.test((await p.textContent("#findCount")).trim()), "find counter: " + (await p.textContent("#findCount")).trim());
    await p.keyboard.press("Escape");
    await p.click("#btnClose");
    await waitFn(p, `!document.querySelector('#modal').hidden`);
    ok((await p.textContent("#modalTitle")) === "Fermer ce PDF ?" && (await p.textContent("#modalOk")) === "Fermer", "confirmation window in French");
    await p.click("#modalCancel");
    await p.evaluate(() => toast("Drop a PDF file (or font files)", true));
    ok(/Déposez un fichier PDF/.test(await p.textContent("#toast")), "messages in French");
    await ctx.close();

    // ---------------------------------------------------------------- right to left (Arabic)
    const rtl = await browser.newContext({ locale: "ar-EG", viewport: { width: 1400, height: 900 } });   // an Arabic browser
    await rtl.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); });
    const q = await rtl.newPage();
    q.on("pageerror", (e) => errs.push(e.message));
    await q.goto(URL0);
    await waitFn(q, `document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait')`, 60000);
    ok((await q.getAttribute("html", "dir")) === "rtl" && (await q.getAttribute("html", "lang")) === "ar" && /[\u0600-\u06FF]/.test(await q.textContent("#toolbar")), "Arabic browser: Arabic, right to left");
    const order = await q.evaluate(() => { const b = [...document.querySelectorAll("#toolbar .group")]; return b.map((g) => g.getBoundingClientRect().left); });
    ok(order.length > 2 && order[0] > order[order.length - 1], "toolbar mirrored (first group on the right)");
    await q.evaluate(() => call("discard"));
    await q.setInputFiles("#fileInput", pdf);
    await waitFn(q, `S.doc && S.spans[S.doc.pages[0].v] && pageEl(0).dataset.rkey`);
    ok(await q.evaluate(() => getComputedStyle(document.querySelector("#pages")).direction === "ltr"), "the PDF pages are not mirrored");
    const side = await q.evaluate(() => { const s = document.querySelector("#sidebar").getBoundingClientRect(), v = document.querySelector("#viewer").getBoundingClientRect(); return s.left > v.left; });
    ok(side, "page list on the right side");
    const s2 = await q.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === "14 Harbour Street"); const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 5) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
    await q.mouse.click(s2.x, s2.y);
    ok(await waitFn(q, `S.ed && S.ed.span.text.trim() === "14 Harbour Street"`), "clicking text still opens the right text (coordinates not mirrored)");
    await q.keyboard.press("Escape");
    await q.screenshot({ path: `/tmp/pdfe-site/${name}-rtl.png` });
    await rtl.close();
    // ---------------------------------------------------------------- every language, from the browser's language
    const LANGS = (await (await fetch(new URL("i18n/languages.json", URL0))).json()).filter((l) => l.code !== "en");
    for (const L of LANGS) {
      const c = await browser.newContext({ locale: L.code === "pt" ? "pt-BR" : L.code === "zh" ? "zh-CN" : L.code, viewport: { width: 1400, height: 900 } });
      await c.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
      const g = await c.newPage();
      g.on("pageerror", (e) => errs.push(`${L.code}: ${e.message}`));
      await g.goto(URL0);
      await waitFn(g, `document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait')`, 60000);
      const lang = await g.getAttribute("html", "lang"), dir = await g.getAttribute("html", "dir");
      // untranslated = a visible text that is, word for word, an English source text whose translation differs
      const dict = await (await fetch(new URL(`i18n/${L.code}.json`, URL0))).json();
      const untranslated = (d) => {
        const out = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const t = n.nodeValue.trim(), el = n.parentElement;
          if (!t || el.closest("script,style,.editbox,#docName,#fontList,[data-noi18n],select,option") || el.closest("[hidden]") || !el.getClientRects().length) continue;
          if (Object.prototype.hasOwnProperty.call(d.strings, t) && d.strings[t].trim() !== t) out.push(t);
        }
        for (const b of document.querySelectorAll("#toolbar [title]")) { const t = b.title; if (Object.prototype.hasOwnProperty.call(d.strings, t) && d.strings[t] !== t) out.push("title: " + t); }
        return out;
      };
      let left = await g.evaluate(untranslated, dict);
      await g.setInputFiles("#fileInput", pdf);
      await waitFn(g, `S.doc && S.spans[S.doc.pages[0].v] && pageEl(0).dataset.rkey`);
      left = left.concat(await g.evaluate(untranslated, dict));
      const fits = await g.evaluate(() => { const tb = document.querySelector("#toolbar"); return tb.scrollWidth <= tb.clientWidth + 1; });
      const picker = await g.evaluate(() => { const o = document.querySelector("#langPick option"); return o && o.value === "auto" && o.selected; });
      ok(lang === L.code && dir === L.dir && !left.length && fits, `${L.name} (${L.code}, ${L.dir}): chosen from the browser, nothing left in English, toolbar fits` + (left.length ? " – " + left.slice(0, 3).join(" | ") : ""));
      if (!picker) ok(false, `${L.code}: the language menu shows “browser language”`);
      if (L.dir === "rtl" && name === "chromium") await g.screenshot({ path: `/tmp/pdfe-site/editor-${L.code}.png` });
      await c.close();
    }

    // ---------------------------------------------------------------- browser language unless chosen
    {
      const c = await browser.newContext({ locale: "de-DE" });
      const g = await c.newPage();
      await g.goto(URL0);
      await waitFn(g, `document.body.classList.contains('engine-ready')`, 60000);
      ok((await g.getAttribute("html", "lang")) === "de" && (await g.evaluate(() => localStorage.getItem("pdfe.lang"))) === null, "German browser: German, and nothing stored (it keeps following the browser)");
      await g.selectOption("#langPick", "it");
      await waitFn(g, `document.documentElement.lang === "it" && document.body.classList.contains('engine-ready')`, 60000);
      ok((await g.evaluate(() => localStorage.getItem("pdfe.lang"))) === "it", "choosing Italian: remembered");
      await g.reload(); await waitFn(g, `document.body.classList.contains('engine-ready')`, 60000);
      ok((await g.getAttribute("html", "lang")) === "it", "…and kept after a reload");
      await g.selectOption("#langPick", "auto");
      await waitFn(g, `document.documentElement.lang === "de" && document.body.classList.contains('engine-ready')`, 60000);
      ok((await g.evaluate(() => localStorage.getItem("pdfe.lang"))) === null, "“Browser language”: back to German, choice forgotten");
      await c.close();
    }
    ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
  } catch (e) {
    fails++; console.log(`  FAIL [${name}] exception: ${e.message.split("\n")[0]}`);
  }
  await browser.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}\n`);
  return fails;
}

for (const n of which === "all" ? ["chromium", "firefox", "webkit"] : [which]) total += await run(n);
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
