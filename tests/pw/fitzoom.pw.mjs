// Pages fit the window's width, in Chromium, Firefox and WebKit:
//  - opening a PDF on a phone (390 px): the page fills the width (8 px margins), no sideways scroll
//  - a desktop window made narrow (1400 → 400 px, like the phone view of the developer tools): the pages follow
//  - widened again: they grow back (up to the usual 160 %)
//  - after a zoom by hand, widening keeps that zoom; narrowing below the page brings it back to fit
//  - the height alone (a phone keyboard) changes nothing; two fingers zoom the pages
// Run: node fitzoom.pw.mjs [chromium|firefox|webkit|all] [url]
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", URL0 = process.argv[3] || "http://127.0.0.1:8766/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;
const m = (p) => p.evaluate(() => { const v = document.querySelector("#viewer"), r = pageEl(0).getBoundingClientRect();
  return { z: S.zoom, auto: !!S.autoFit, page: Math.round(r.width), left: Math.round(r.left), vw: v.clientWidth, scrolls: v.scrollWidth > v.clientWidth + 1 }; });
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0; const ok = (c, msg) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${msg}`); if (!c) fails++; };
  const b = name === "chromium" ? await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch()) : await engine.launch();
  try {
    const open = async (vp, touch) => {
      const c = await b.newContext({ viewport: vp, hasTouch: !!touch });
      await c.addInitScript(() => { localStorage.setItem("pdfe.coachSeen", "1"); localStorage.setItem("pdfe.fontIntroSeen", "1"); });
      await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
      const p = await c.newPage();
      await p.goto(URL0); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
      await p.setInputFiles("#fileInput", pdf); await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey);
      await sleep(300); return [c, p];
    };
    // phone
    let [c, p] = await open({ width: 390, height: 844 }, true);
    let r = await m(p);
    ok(r.page >= r.vw - 30 && r.page <= r.vw && !r.scrolls, `phone: page ${r.page} px fills the ${r.vw} px screen, no sideways scroll`);
    await p.setViewportSize({ width: 390, height: 500 }); await sleep(400);
    ok((await m(p)).z === r.z, `phone: a shorter screen (keyboard) keeps the zoom`);
    // pinch with two fingers (pointer events, as a touch screen sends them)
    const z0 = (await m(p)).z;
    await p.evaluate(() => {
      const v = document.querySelector("#viewer"), r = v.getBoundingClientRect(), y = r.top + 200;
      const ev = (type, id, x) => v.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, isPrimary: id === 1 }));
      ev("pointerdown", 1, 150); ev("pointerdown", 2, 250);
      ev("pointermove", 1, 100); ev("pointermove", 2, 300);
    });
    await sleep(300);
    await p.evaluate(() => { const v = document.querySelector("#viewer"); for (const id of [1, 2]) v.dispatchEvent(new PointerEvent("pointerup", { pointerId: id, pointerType: "touch", bubbles: true })); });
    r = await m(p);
    ok(r.z > z0 * 1.6 && !r.auto, `phone: two fingers apart zoom in (${z0.toFixed(2)} → ${r.z.toFixed(2)})`);
    await c.close();

    // desktop window made narrow, then wide
    [c, p] = await open({ width: 1400, height: 900 });
    const big = await m(p);
    ok(big.z === 1.6 && big.auto, `1400 px: opened at 160 %, following the width`);
    await p.setViewportSize({ width: 400, height: 670 }); await sleep(500);
    r = await m(p);
    ok(r.page <= r.vw && r.page >= r.vw - 30 && !r.scrolls, `1400 → 400 px: page ${r.page} px fits the ${r.vw} px viewer`);
    await p.setViewportSize({ width: 1400, height: 900 }); await sleep(500);
    r = await m(p);
    ok(Math.abs(r.z - 1.6) < 0.01, `400 → 1400 px: back to 160 %`);
    // zoom by hand: kept when widening, refit when the window becomes narrower than the page
    await p.click("#btnZoomOut"); await sleep(300);
    const zHand = (await m(p)).z;
    await p.setViewportSize({ width: 1600, height: 900 }); await sleep(500);
    ok((await m(p)).z === zHand, `zoomed by hand (${Math.round(zHand * 100)} %): widening keeps it`);
    await p.setViewportSize({ width: 500, height: 800 }); await sleep(500);
    r = await m(p);
    ok(r.page <= r.vw && !r.scrolls && r.auto, `narrowed below the page: fits again (${r.page} ≤ ${r.vw})`);
    await c.close();
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
  await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
}
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
