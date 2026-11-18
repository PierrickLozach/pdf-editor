// Offline editing, and never a silently dropped letter.
// 1. Load the editor, go offline, open the fictional invoice, change 2,100.00 into 2,450.00: the 4 is not in the
//    PDF's own font subset and the editor's fonts cannot be downloaded, so the engine's built-in fonts must draw it
//    (before: the 4 was left out without a word and the amount became 2,40.00).
// 2. Still offline, type a character that no available font has: the edit is refused with a clear message and the
//    page is not changed.
// Run: node offline.pw.mjs [chromium|firefox|webkit|all] [url]
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", B = process.argv[3] || "http://localhost:8787/app/";
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch();
  try {
    const c = await b.newContext({ viewport: { width: 1280, height: 800 } });
    await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
    await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
    const p = await c.newPage();
    await p.goto(B); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1000));
    await c.setOffline(true);
    await p.setInputFiles("#fileInput", new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname);
    await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey && S.spans && S.spans[S.doc.pages[0].v], null, { timeout: 30000 });
    const edit = async (from, to) => {
      const at = await p.evaluate((t) => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === t), r = pageEl(0).getBoundingClientRect();
        return s && [r.left + (s.tbox[0] + s.tbox[2]) / 2 * S.zoom, r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom]; }, from);
      if (!at) return false;
      await p.mouse.click(...at); await p.waitForFunction(() => S.ed);
      await p.keyboard.press("End"); for (let i = 0; i < from.length; i++) await p.keyboard.press("Backspace");
      await p.keyboard.type(to); await p.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 1800));
      return true;
    };
    const find = (t) => p.evaluate(async (t) => (await call("find", t, false, false)).length, t);
    ok(await edit("2,100.00", "2,450.00"), "offline: the amount line opens for editing");
    await p.waitForFunction(() => !S.ed, null, { timeout: 10000 }).catch(() => {});
    ok(await find("2,450.00") === 1 && await find("2,40.00") === 0, "offline: 2,100.00 became exactly 2,450.00 (the 4, missing from the PDF's font, is drawn with a built-in font)");
    const v0 = await p.evaluate(() => S.doc.pages[0].v);
    await edit("2,520.00", "2,520.00 合");
    const toast = await p.evaluate(() => (document.querySelector("#toast") || {}).textContent || "");
    ok(/cannot be written with the fonts available/.test(toast) && /合/.test(toast), "offline: a character no font has is refused with a clear message: " + toast.slice(0, 120));
    await p.keyboard.press("Escape"); await new Promise((r) => setTimeout(r, 400));
    ok(await p.evaluate((v) => S.doc.pages[0].v === v, v0) && await find("2,520.00") === 1, "…and the page is left unchanged");
    await c.setOffline(false);
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
  await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
}
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
