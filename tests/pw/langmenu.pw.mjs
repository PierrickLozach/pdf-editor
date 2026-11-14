// Changing the language from the toolbar while a PDF is open: the button shows the language, its menu lists
// "Browser language" and the 12 languages, choosing one reloads the page in that language with the same PDF
// open (with its edits, at the same zoom and place), and the choice is remembered; "Browser language" forgets it.
// Run: node langmenu.pw.mjs [chromium|firefox|webkit|all] [url]
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", URL0 = process.argv[3] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch(); const c = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
  await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
  const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const ready = () => p.waitForFunction(() => document.body.classList.contains("engine-ready") && window.I18N && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
  try {
    await p.goto(URL0); await ready();
    ok(await p.isVisible("#btnLang") && (await p.textContent("#btnLangName")) === "English", "the toolbar shows a language button: " + (await p.textContent("#btnLangName")));
    await p.setInputFiles("#fileInput", pdf); await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey);
    // an edit, a zoom and a scroll position to keep
    await p.evaluate(async () => {
      const sp = await call("pageText", 0), t = sp.find((x) => x.text.trim() === "Blue Harbor Consulting");
      applyInfo(await call("editSpan", 0, t.id, t.text, "Blue Lake Consulting"));
      setZoom(2.2);
    });
    await sleep(400);
    await p.evaluate(() => { document.querySelector("#viewer").scrollTop = 300; });
    const before = await p.evaluate(() => ({ zoom: S.zoom, top: document.querySelector("#viewer").scrollTop, name: S.doc.name }));
    ok(await p.isVisible("#btnLang"), "the button is there with a PDF open");
    await p.click("#btnLang");
    const items = await p.evaluate(() => [...document.querySelectorAll("#langMenu button")].map((x) => x.dataset.code));
    ok(items.length === 13 && items[0] === "auto" && items.includes("fr") && items.includes("ar"), "the menu lists Browser language and the 12 languages: " + items.join(","));
    ok(await p.isVisible("#langMenu .lm-note"), "with edits, the menu says the PDF stays open and the undo history starts again");
    await Promise.all([p.waitForNavigation(), p.click('#langMenu button[data-code="fr"]')]);
    await ready();
    await p.waitForFunction(() => typeof S !== "undefined" && S.doc && pageEl(0) && pageEl(0).dataset.rkey, null, { timeout: 30000 });
    await sleep(500);
    const after = await p.evaluate(async () => ({ lang: document.documentElement.lang, btn: document.querySelector("#btnLangName").textContent, tools: document.querySelector("#btnTools span").textContent,
      name: S.doc.name, zoom: S.zoom, top: document.querySelector("#viewer").scrollTop, dirty: S.dirty,
      edited: (await call("pageText", 0)).some((x) => /Blue Lake Consulting/.test(x.text)), stored: localStorage.getItem("pdfe.lang") }));
    ok(after.lang === "fr" && after.btn === "Français" && after.tools === "Outils", "the editor is now in French: " + JSON.stringify([after.btn, after.tools]));
    ok(after.name === before.name && after.edited, "the same PDF is open, with its edit");
    ok(Math.abs(after.zoom - before.zoom) < 0.01 && Math.abs(after.top - before.top) < 40, `same zoom and place (${after.zoom}/${before.zoom}, ${after.top}/${before.top})`);
    const noteOk = await p.waitForFunction(() => /Non enregistré/.test((document.querySelector("#saveState") || {}).textContent || ""), null, { timeout: 8000 }).then(() => true, () => false);
    ok(after.dirty === true && noteOk, "it is still marked as not saved (« Non enregistré »)");
    ok(after.stored === "fr", "the choice is remembered");
    // back to the browser's language
    await p.click("#btnLang");
    await Promise.all([p.waitForNavigation(), p.click('#langMenu button[data-code="auto"]')]);
    await ready(); await p.waitForFunction(() => typeof S !== "undefined" && S.doc, null, { timeout: 30000 });
    ok(await p.evaluate(() => document.documentElement.lang === "en" && !localStorage.getItem("pdfe.lang")), "“Browser language” goes back to English and forgets the choice");
    // keyboard: Esc closes the menu
    await p.click("#btnLang"); await p.keyboard.press("Escape");
    ok(await p.evaluate(() => document.querySelector("#langMenu").hidden), "Esc closes the menu");
    // right to left: the menu opens inside the window
    await p.evaluate(() => localStorage.setItem("pdfe.lang", "ar")); await p.reload(); await ready(); await p.waitForFunction(() => typeof S !== "undefined" && S.doc, null, { timeout: 30000 }).catch(() => {});
    await p.click("#btnLang");
    const r = await p.evaluate(() => { const m = document.querySelector("#langMenu").getBoundingClientRect(); return [m.left, m.right, innerWidth]; });
    ok(r[0] >= 0 && r[1] <= r[2], "in Arabic the menu opens inside the window " + JSON.stringify(r));
    ok(!errs.length, "no script errors " + errs.slice(0, 2).join(" | "));
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
  await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
}
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
