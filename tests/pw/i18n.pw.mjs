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

    // ---------------------------------------------------------------- right-to-left (test language)
    const rtl = await browser.newContext({ locale: "en-US", viewport: { width: 1400, height: 900 } });
    await rtl.addInitScript(() => { window.PDFE_EXTRA_LANGS = [["rtl", "RTL test", "rtl"]]; localStorage.setItem("pdfe.lang", "rtl"); localStorage.setItem("pdfe.fontIntroSeen", "1"); });
    await rtl.route(/\/i18n\/rtl\.json/, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ strings: { "Open": "ופתח", "Edit text": "ערוך טקסט", "Drop a PDF here": "גרור לכאן קובץ PDF" } }) }));
    const q = await rtl.newPage();
    q.on("pageerror", (e) => errs.push(e.message));
    await q.goto(URL0);
    await waitFn(q, `document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait')`, 60000);
    ok((await q.getAttribute("html", "dir")) === "rtl" && /ופתח/.test(await q.textContent("#toolbar")), "right-to-left language: dir=rtl, texts replaced");
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
