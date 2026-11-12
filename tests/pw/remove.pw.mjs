// Deleting items in a real browser: a click on a tilted watermark selects it (with its other lines),
// Delete removes it on this page, "Delete on every page" everywhere; the bin of the editing bar
// deletes a line of text; a click on a picture selects it, Delete key removes it; Esc cancels;
// one undo step each. Built on the fictional invoice (watermark and logo added by the test).
// Run: node remove.pw.mjs [chromium|firefox|webkit|all] [url]
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all";
const URL0 = process.argv[3] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const png = new URL("../../web/icon.png", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch(); const c = await b.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
  await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
  const p = await c.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  const waitFn = async (expr, t = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await p.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); } return false; };
  const idle = () => waitFn(`!document.body.classList.contains("busy")`);
  const find = (q) => p.evaluate((q) => call("find", q).then((h) => h.map((x) => x.page)), q);
  const center = (sel) => p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  try {
    await p.goto(URL0);
    await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
    await p.setInputFiles("#fileInput", pdf);
    await waitFn(`S.doc && pageEl(0).dataset.rkey`);
    // 3 pages, a tilted watermark and a logo on each (one undo step each, so the test starts clean)
    const logo = Array.from(await (await import("node:fs")).promises.readFile(png));
    await p.evaluate(async (logo) => {
      await pageAction("duplicate", 0); await pageAction("duplicate", 0);
      applyInfo(await call("watermark", "CONFIDENTIAL COPY", { opacity: 0.25 }));
      for (let i = 0; i < 3; i++) applyInfo(await call("addImage", i, [440, 700, 520, 780], new Uint8Array(logo), false));
    }, logo);
    await idle(); await waitFn(`document.querySelector('#pages .page .span.locked') && document.querySelector('#pages .page .imgpick')`);
    ok((await find("CONFIDENTIAL")).length === 3, "setup: a tilted watermark on 3 pages");
    // 1. a click on the watermark selects it
    await p.mouse.click(...await center("#pages .page .span.locked"));
    ok(await waitFn(`!document.querySelector('#removeBar').hidden && document.querySelector('.rm-sel')`), "a click on the tilted watermark selects it (frame + bar)");
    const barText = await p.textContent("#removeBar");
    ok(/Stamp or watermark/.test(barText) && /Delete on every page \(3\)/.test(barText), "the bar offers Delete and “Delete on every page (3)”: " + barText.replace(/\s+/g, " ").trim());
    ok(await p.evaluate(() => !S.ed), "it does not open the text editor");
    // Esc cancels
    await p.keyboard.press("Escape");
    ok(await waitFn(`document.querySelector('#removeBar').hidden && !document.querySelector('.rm-sel')`), "Esc cancels the selection");
    // 2. Delete on this page only
    await p.mouse.click(...await center("#pages .page .span.locked"));
    await waitFn(`!document.querySelector('#removeBar').hidden`);
    await p.click("#removeBar .rm-one"); await idle();
    ok(JSON.stringify(await find("CONFIDENTIAL")) === "[1,2]", "Delete: gone from page 1 only");
    ok((await find("Blue Harbor Consulting")).length === 3 && (await find("Total due")).length === 3, "the rest of the text is kept");
    await p.click("#btnUndo"); await idle();
    ok((await find("CONFIDENTIAL")).length === 3, "Undo brings it back");
    // 3. Delete on every page
    await waitFn(`document.querySelector('#pages .page .span.locked')`);
    await p.mouse.click(...await center("#pages .page .span.locked"));
    await waitFn(`!document.querySelector('#removeBar').hidden`);
    await p.click("#removeBar .rm-all"); await idle();
    ok((await find("CONFIDENTIAL")).length === 0 && /3 pages/.test(await p.textContent("#toast")), "Delete on every page: gone from the 3 pages in one step (" + (await p.textContent("#toast")) + ")");
    await p.click("#btnUndo"); await idle();
    ok((await find("CONFIDENTIAL")).length === 3, "one Undo brings all three back");
    // 4. a picture: click selects it, the Delete key removes it
    await waitFn(`document.querySelector('#pages .page .imgpick')`);
    await p.evaluate(() => document.querySelector("#pages .page .imgpick").scrollIntoView({ block: "center" })); await sleep(300);
    await p.mouse.click(...await center("#pages .page .imgpick"));
    ok(await waitFn(`!document.querySelector('#removeBar').hidden && /Picture/.test(document.querySelector('#removeBar').textContent)`), "a click on the logo selects it as a picture");
    await p.keyboard.press("Delete"); await idle();
    const imgs = await p.evaluate(async () => [await call("pageImages", 0), await call("pageImages", 1)].map((l) => l.length));
    ok(imgs[0] === 0 && imgs[1] === 1, "the Delete key removes the picture of this page only: " + imgs);
    // 5. a normal line: the bin button of the editing bar
    await p.evaluate(async () => {
      const sp = S.spans[S.doc.pages[0].v].find((s) => s.text.trim() === "Blue Harbor Consulting");
      startEdit(0, sp);
    });
    await waitFn(`S.ed && !document.querySelector('#editorBar').hidden`);
    ok(await p.isVisible("#edDelete"), "the editing bar has a Delete (bin) button");
    await p.click("#edDelete"); await idle();
    ok(JSON.stringify(await find("Blue Harbor Consulting")) === "[1,2]" && (await find("88 Riverside Avenue")).length === 3, "the bin deletes that line only");
    // 6. Edit text still works on normal text after all this
    await p.click("#btnUndo"); await idle();
    ok((await find("Blue Harbor Consulting")).length === 3, "undo the line deletion");
    ok(errs.length === 0, "no script errors " + errs.slice(0, 2).join(" | "));
  } catch (e) { fails++; console.log(`  FAIL [${name}] exception: ${e.message.split("\n")[0]}`); await p.screenshot({ path: `/tmp/pdfe-site/remove-${name}.png` }).catch(() => {}); }
  await b.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  total += fails;
}
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
