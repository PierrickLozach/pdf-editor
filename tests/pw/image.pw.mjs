// Adding an image: one click places ONE frame; it is moved and resized, then added once (Enter,
// "Add" or a click outside it); the editor goes back to Edit text. Esc cancels without adding.
// Run: node image.pw.mjs [chromium|firefox|webkit|all] [url]
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";
import * as mupdf from "../../web/vendor/mupdf/mupdf.js";

const which = process.argv[2] || "all";
const URL0 = process.argv[3] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const png = new URL("../../web/icon.png", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, engine) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, locale: "en-US" });
  await ctx.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const waitFn = async (expr, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); } return false; };
  // how many images the PDF draws on page 1 (counted in the PDF itself, not on screen)
  const drawn = async () => {                            // [x, y, w, h] in points of every image the page draws
    const b64 = await page.evaluate(async () => { const b = await call("export"); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); });
    const doc = mupdf.Document.openDocument(Buffer.from(b64, "base64"), "application/pdf");
    const pg = doc.loadPage(0), out = [], H = pg.getBounds()[3];
    const dev = new mupdf.Device({ fillImage(img, ctm) { out.push([ctm[4], ctm[5], ctm[0], -ctm[3]].map((v) => Math.round(v * 10) / 10)); } });
    pg.run(dev, mupdf.Matrix.identity); dev.close();
    return out;
  };
  const images = async () => (await drawn()).length;
  const box = () => page.evaluate(() => { const a = PLACE.active; return a && { x: a.x, y: a.y, w: a.w, h: a.h }; });
  try {
    await page.goto(URL0);
    await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
    await page.setInputFiles("#fileInput", pdf);
    await waitFn(`S.doc && pageEl(0).dataset.rkey`);
    const n0 = await images();

    // ---------------------------------------------------------------- pick a picture, click once
    await page.keyboard.press("i");                      // Image tool: asks for a picture
    await page.setInputFiles("#imageInput", png);
    ok(await waitFn(`S.tool === "image" && S.image`), "Image tool: picture chosen");
    const pr = await page.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return { x: r.left, y: r.top, z: S.zoom }; });
    const at = (x, y) => [pr.x + x * pr.z, pr.y + y * pr.z];
    const fresh = async () => Object.assign(pr, await page.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return { x: r.left, y: r.top, z: S.zoom }; }));
    await page.mouse.click(...at(300, 400));
    ok(await waitFn(`PLACE.active && document.querySelectorAll('.placer').length === 1`), "a click opens ONE frame to place it");
    await sleep(100);
    Object.assign(pr, await page.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return { x: r.left, y: r.top, z: S.zoom }; }));
    ok(await page.evaluate(() => { const r = document.querySelector(".placer .pl-ok").getBoundingClientRect(), v = document.querySelector("#viewer").getBoundingClientRect(); return r.bottom <= v.bottom && r.top >= v.top; }), "the frame and its buttons are in view");
    ok((await images()) === n0, "nothing is added to the PDF yet");
    // clicking the page again does not add a second one (it confirms the first)
    let b0 = await box();
    ok(Math.abs(b0.x - 300) < 1 && Math.abs(b0.y - 400) < 1 && Math.abs(b0.w - 160) < 1, "frame at the click, 160 pt wide: " + JSON.stringify(b0));

    // ---------------------------------------------------------------- move it
    const c0 = at(b0.x + b0.w / 2, b0.y + b0.h / 2);
    await page.mouse.move(...c0); await page.mouse.down(); await page.mouse.move(c0[0] - 80 * pr.z, c0[1] + 40 * pr.z, { steps: 6 }); await page.mouse.up();
    let b1 = await box();
    ok(Math.abs(b1.x - (b0.x - 80)) < 1.5 && Math.abs(b1.y - (b0.y + 40)) < 1.5 && Math.abs(b1.w - b0.w) < 0.5, "dragging it moves it: " + JSON.stringify(b1));

    // ---------------------------------------------------------------- resize it from a corner (proportions kept)
    const se = await page.evaluate(() => { const r = document.querySelector(".placer .ph.se").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.move(...se); await page.mouse.down(); await page.mouse.move(se[0] + 100 * pr.z, se[1] + 10 * pr.z, { steps: 8 }); await page.mouse.up();
    let b2 = await box();
    ok(b2.w > b1.w + 90 && Math.abs(b2.w / b2.h - b1.w / b1.h) < 0.02 && Math.abs(b2.x - b1.x) < 0.5 && Math.abs(b2.y - b1.y) < 0.5, "a corner resizes it, proportions kept, opposite corner fixed: " + JSON.stringify(b2));
    // the top-left corner, with Shift: free proportions
    const nw = await page.evaluate(() => { const r = document.querySelector(".placer .ph.nw").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.keyboard.down("Shift");
    await page.mouse.move(...nw); await page.mouse.down(); await page.mouse.move(nw[0] + 30 * pr.z, nw[1] - 20 * pr.z, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up("Shift");
    let b3 = await box();
    ok(Math.abs(b3.x - (b2.x + 30)) < 1.5 && Math.abs(b3.y - (b2.y - 20)) < 1.5 && Math.abs((b3.x + b3.w) - (b2.x + b2.w)) < 0.5 && Math.abs((b3.y + b3.h) - (b2.y + b2.h)) < 0.5, "Shift + corner: free proportions, the other corner stays: " + JSON.stringify(b3));
    // arrow keys nudge it
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Shift+ArrowDown");
    let b4 = await box();
    ok(Math.abs(b4.x - (b3.x + 1)) < 0.01 && Math.abs(b4.y - (b3.y + 10)) < 0.01, "arrow keys nudge it (1 pt, Shift 10 pt)");
    ok((await images()) === n0, "still nothing added while adjusting");

    // ---------------------------------------------------------------- add it: once, then Edit text
    await page.keyboard.press("Enter");
    ok(await waitFn(`!PLACE.active && S.tool === "edit" && !document.querySelector('.placer')`), "Enter adds it and goes back to Edit text");
    ok((await images()) === n0 + 1, `exactly one image added (${n0} → ${await images()})`);
    const where = await drawn();
    ok(where.length === 1 && Math.abs(where[0][2] - b4.w) < 0.6 && Math.abs(Math.abs(where[0][3]) - b4.h) < 0.6, "drawn once, at the size of the frame: " + JSON.stringify(where[0]) + " vs " + JSON.stringify(b4));
    ok(await page.evaluate(() => document.querySelector('.tool[data-tool="edit"]').classList.contains("active")), "the Edit text button is active again");

    // ---------------------------------------------------------------- undo removes it
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    ok(await waitFn(`true`) && (await images()) === n0, "undo removes it in one step");

    // ---------------------------------------------------------------- the "Add" button; a click outside the frame
    await page.keyboard.press("i"); await page.setInputFiles("#imageInput", png);
    await waitFn(`S.tool === "image" && S.image`);
    await fresh(); await page.mouse.click(...at(100, 600));
    await waitFn(`PLACE.active`);
    await page.click(".placer .pl-ok");          // (the frame was scrolled into view)
    ok(await waitFn(`!PLACE.active && S.tool === "edit"`) && (await images()) === n0 + 1, "the “Add” button adds it once");
    await page.keyboard.press("i"); await page.setInputFiles("#imageInput", png);
    await waitFn(`S.tool === "image" && S.image`);
    await page.evaluate(() => { document.querySelector("#viewer").scrollTop = 0; }); await sleep(100); await fresh();
    await page.mouse.click(...at(350, 150));
    await waitFn(`PLACE.active`);
    await sleep(100); await fresh();
    await page.mouse.click(...at(60, 300));               // elsewhere on the page (blank area)
    ok(await waitFn(`!PLACE.active && S.tool === "edit"`) && (await images()) === n0 + 2 && !(await page.evaluate(() => !!S.ed)), "a click elsewhere on the page adds it (once), and does not start another frame or a text edit");

    // ---------------------------------------------------------------- Esc cancels; Cancel button
    await page.keyboard.press("i"); await page.setInputFiles("#imageInput", png);
    await waitFn(`S.tool === "image" && S.image`);
    await fresh(); await page.mouse.click(...at(200, 300)); await waitFn(`PLACE.active`);
    await page.keyboard.press("Escape");
    ok(await waitFn(`!PLACE.active && S.tool === "edit"`) && (await images()) === n0 + 2, "Esc cancels: nothing added, back to Edit text");
    await page.keyboard.press("i"); await page.setInputFiles("#imageInput", png);
    await waitFn(`S.tool === "image" && S.image`);
    await fresh(); await page.mouse.click(...at(200, 300)); await waitFn(`PLACE.active`);
    await page.click(".placer .pl-cancel");
    ok(await waitFn(`!PLACE.active && S.tool === "edit"`) && (await images()) === n0 + 2, "the “Cancel” button: nothing added");

    // ---------------------------------------------------------------- drag to draw its size; zoom keeps the frame in place
    await page.keyboard.press("i"); await page.setInputFiles("#imageInput", png);
    await waitFn(`S.tool === "image" && S.image`);
    await page.evaluate(() => { document.querySelector("#viewer").scrollTop = 0; }); await sleep(100); await fresh();
    await page.mouse.move(...at(100, 100)); await page.mouse.down(); await page.mouse.move(...at(300, 220), { steps: 6 }); await page.mouse.up();
    const bd = await box();
    ok(bd && Math.abs(bd.x - 100) < 1 && Math.abs(bd.y - 100) < 1 && bd.h <= 121 && bd.w <= 201 && (Math.abs(bd.w - 200) < 1 || Math.abs(bd.h - 120) < 1), "dragging draws its size (fitted, proportions kept): " + JSON.stringify(bd));
    await page.click("#btnZoomIn");
    await waitFn(`S.zoom > ${pr.z}`);
    const scr = await page.evaluate(() => { const r = document.querySelector(".placer").getBoundingClientRect(), p = pageEl(PLACE.active.page).getBoundingClientRect(); return { x: (r.left - p.left) / S.zoom, w: r.width / S.zoom }; });
    ok(Math.abs(scr.x - bd.x) < 1 && Math.abs(scr.w - bd.w) < 1, "after zooming, the frame is still over the same spot");
    await page.click('.tool[data-tool="erase"]');
    ok(await waitFn(`!PLACE.active`) && (await images()) === n0 + 2, "choosing another tool drops the frame without adding it");
    ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
  } catch (e) {
    fails++; console.log(`  FAIL [${name}] exception: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `/tmp/pdfe-site/image-${name}-failure.png` }).catch(() => {});
  }
  await browser.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  return fails;
}

let total = 0;
for (const [n, e] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) if (which === "all" || which === n) total += await run(n, e);
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
