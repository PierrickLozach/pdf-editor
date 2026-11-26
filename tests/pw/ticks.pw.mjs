// Tick boxes and pictures in the Edit text tool, in Chromium, Firefox and WebKit:
// a click on a tick box ticks / unticks it (no editing box), a click on a mark typed over a box removes
// it; a signature (picture) is dragged to a new place, resized from a corner (proportions kept),
// nudged with the arrow keys, and each is one undo step.
// Run from tests/pw: node ticks.pw.mjs [chromium|firefox|webkit|all] [url]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { signaturePng } from "../fixtures/make-signature-png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = path.join(here, "..", "fixtures", "ticks-signature.pdf");
const which = process.argv[2] || "all";
const url = process.argv[3] || "http://127.0.0.1:8766/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const png = Array.from(signaturePng());
let total = 0;

async function run(name) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await { chromium, firefox, webkit }[name].launch();
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const waitFn = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); }
    return false;
  };
  const settled = () => waitFn(`!S.pending && !document.body.classList.contains("busy") && pageEl(0).dataset.rkey && pageEl(0).dataset.rkey.startsWith(S.doc.pages[0].v) && S.spans[S.doc.pages[0].v]`);
  const spans = () => page.evaluate(() => S.spans[S.doc.pages[0].v] || []);
  const boxOf = async (label) => {
    const sp = await spans(), w = sp.find((s) => s.text.includes(label));
    return sp.filter((s) => (s.box === "empty" || s.box === "checked") && Math.abs(s.tbox[1] - w.tbox[1]) < 4 && s.tbox[2] <= w.tbox[0] + 3).sort((a, b) => b.tbox[2] - a.tbox[2])[0];
  };
  const scr = (x, y) => page.evaluate(([x, y]) => { const r = pageEl(0).getBoundingClientRect(); return [r.left + x * S.zoom, r.top + y * S.zoom]; }, [x, y]);
  const clickAt = async (x, y) => { const [cx, cy] = await scr(x, y); await page.mouse.click(cx, cy); };
  const images = () => page.evaluate(() => call("pageImages", 0));
  const close = (a, b, tol = 0.8) => a && b && a.every((v, k) => Math.abs(v - b[k]) < tol);
  try {
    await page.goto(url);
    await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
    await page.evaluate(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); window.PDFE_STATS_TEST = 1; return call("discard"); });
    await page.setInputFiles("#fileInput", pdf);
    await waitFn(`S.doc && pageEl(0).dataset.rkey && S.spans[S.doc.pages[0].v]`);
    await settled();

    /* ---- tick boxes */
    let a = await boxOf("Option A");
    ok(a && a.box === "empty", "box A is an empty tick box");
    ok(await page.evaluate(() => !!document.querySelector(".span.cbox")), "tick boxes show a pointer (class cbox)");
    await clickAt((a.tbox[0] + a.tbox[2]) / 2, (a.tbox[1] + a.tbox[3]) / 2);
    await waitFn(`S.doc.pages[0].v !== ${JSON.stringify((await page.evaluate(() => S.doc.pages[0].v)))} || false`, 300);
    await settled();
    a = await boxOf("Option A");
    ok(a && a.box === "checked" && a.text.trim() === "☑", "a click on an empty box ticks it: " + (a && a.text.trim()));
    ok(await page.evaluate(() => !S.ed), "…without opening the text editor");
    await clickAt((a.tbox[0] + a.tbox[2]) / 2, (a.tbox[1] + a.tbox[3]) / 2);
    await sleep(200); await settled();
    a = await boxOf("Option A");
    ok(a && a.box === "empty", "a second click unticks it");
    const sp = await spans(), mark = sp.find((s) => s.box === "mark");
    ok(!!mark, "the mark typed over box C is recognised");
    await clickAt((mark.tbox[0] + mark.tbox[2]) / 2, (mark.tbox[1] + mark.tbox[3]) / 2);
    await sleep(200); await settled();
    const c = await boxOf("Option C");
    ok(c && c.box === "empty" && !(await spans()).some((s) => s.box === "mark"), "a click on the mark removes it, the box stays");
    await page.keyboard.press(`${MOD}+z`); await sleep(200); await settled();
    ok((await spans()).some((s) => s.box === "mark"), "undo brings the mark back");

    /* ---- a signature: drag, resize, nudge */
    await page.evaluate(async (bytes) => { applyInfo(await call("addImage", 0, [330, 400, 530, 470], new Uint8Array(bytes), true)); }, png);
    await settled(); await sleep(300);
    let [im] = await images();
    ok(close(im.bbox, [330, 400, 530, 470]), "signature placed at [330,400,530,470]");
    // drag it by its middle, 30 pt left and 75 pt up, into the signature box
    let [x0, y0] = await scr(430, 435);
    await page.mouse.move(x0, y0); await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x0 - 30 * i / 10 * (await page.evaluate(() => S.zoom)), y0 - 75 * i / 10 * (await page.evaluate(() => S.zoom)));
    ok(await page.evaluate(() => !!document.querySelector(".rm-ghost")), "the picture follows the pointer while dragging");
    await page.mouse.up();
    await waitFn(`REMOVE.sel && REMOVE.sel.kind === "image" && Math.abs(REMOVE.sel.im.bbox[0] - 300) < 1.5`, 8000);
    await settled();
    [im] = await images();
    ok(close(im.bbox, [300, 325, 500, 395], 1.5), "dragged to its new place: " + JSON.stringify(im.bbox));
    ok(await page.evaluate(() => !document.querySelector("#removeBar").hidden && !document.querySelector(".rm-hint").hidden), "it stays selected, with the move/resize hint");
    ok(await page.evaluate(() => document.querySelectorAll(".rm-handle").length === 4), "four corner handles");
    // resize from the bottom-right corner: 40 pt to the right
    const h = await page.evaluate(() => { const r = document.querySelector(".rm-handle.se").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    const z = await page.evaluate(() => S.zoom);
    await page.mouse.move(h[0], h[1]); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(h[0] - 40 * z * i / 8, h[1] - 14 * z * i / 8);
    await page.mouse.up();
    await waitFn(`REMOVE.sel && REMOVE.sel.kind === "image" && REMOVE.sel.im.bbox[2] < 480`, 8000);
    await settled();
    [im] = await images();
    const w = im.bbox[2] - im.bbox[0], hh = im.bbox[3] - im.bbox[1];
    ok(Math.abs(im.bbox[0] - 300) < 1.5 && Math.abs(im.bbox[1] - 325) < 1.5 && w < 190 && w > 140, "resized from the corner, the opposite corner stays: " + JSON.stringify(im.bbox));
    ok(Math.abs(w / hh - 200 / 70) < 0.05, "proportions kept: " + (w / hh).toFixed(3));
    // arrows: 3 pt to the right, applied once the keys stop
    const before = im.bbox;
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await waitFn(`REMOVE.sel && Math.abs(REMOVE.sel.im.bbox[0] - ${before[0] + 3}) < 0.3`, 8000);
    await settled();
    [im] = await images();
    ok(Math.abs(im.bbox[0] - before[0] - 3) < 0.3 && Math.abs(im.bbox[1] - before[1]) < 0.3, "arrow keys nudge it (3 × 1 pt)");
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${MOD}+z`); await sleep(200); await settled();
    [im] = await images();
    ok(close(im.bbox, before, 0.3), "undo: one step per move");
    ok((await images()).length === 1, "still one picture on the page");
    // clicking it again selects it; a click elsewhere drops the selection
    await clickAt((im.bbox[0] + im.bbox[2]) / 2, (im.bbox[1] + im.bbox[3]) / 2);
    ok(await waitFn(`REMOVE.sel && REMOVE.sel.kind === "image"`, 3000), "a click on the signature selects it again");
    await clickAt(150, 250);
    const dropped = await waitFn(`!REMOVE.sel`, 3000);
    ok(dropped, "a click elsewhere drops the selection" + (dropped ? "" : ": " + await page.evaluate(() => { const [x, y] = [pageEl(0).getBoundingClientRect().left + 150 * S.zoom, pageEl(0).getBoundingClientRect().top + 250 * S.zoom]; const el = document.elementFromPoint(x, y); return (el && el.className) + " sel=" + JSON.stringify(REMOVE.sel && REMOVE.sel.im.bbox) + " y=" + y + " h=" + innerHeight; })));
    ok(!errs.length, `no script errors${errs.length ? ": " + errs.join(" | ") : ""}`);
  } catch (e) { ok(false, "exception: " + e.message); }
  await browser.close();
  total += fails;
}

for (const n of which === "all" ? ["chromium", "firefox", "webkit"] : [which]) await run(n);
console.log(total ? `${total} FAILED` : "all tick box and picture checks passed");
process.exit(total ? 1 : 0);
