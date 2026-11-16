// Whiteout in a real browser on a PDF whose text sits in a Stamp annotation (fictional invoice + "APPROVED").
// Before the fix the white box was drawn under the stamp and the stamp stayed visible. Run: node stamps.pw.mjs [browser|all] [url]
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", B = (process.argv[3] || "http://localhost:8787/app/");
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch();
  try {
    const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
    await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
    const p = await c.newPage(); await p.goto(B);
    await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
    await p.setInputFiles("#fileInput", new URL("../fixtures/stamp-text.pdf", import.meta.url).pathname);
    await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey && S.spans && S.spans[S.doc.pages[0].v], null, { timeout: 30000 });
    // red pixels in the stamp area, read from the page as drawn
    const red = () => p.evaluate(() => { const cv = pageEl(0).querySelector("canvas"), g = cv.getContext("2d"), k = cv.width / S.doc.pages[0].w;
      const d = g.getImageData(300 * k, 600 * k, 220 * k, 60 * k).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) n++; return n; });
    ok((await red()) > 200, "the red APPROVED stamp is shown");
    ok(await p.evaluate(() => S.spans[S.doc.pages[0].v].some((s) => /APPROVED/.test(s.text))), "its text is page text (clickable like the rest)");
    await p.keyboard.press("w");
    const at = await p.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return { x: r.left + 290 * S.zoom, y: r.top + 590 * S.zoom, x2: r.left + 530 * S.zoom, y2: r.top + 670 * S.zoom }; });
    await p.evaluate((y) => { document.querySelector("#viewer").scrollTop += y - 300; }, at.y);
    await new Promise((r) => setTimeout(r, 300));
    const at2 = await p.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return { x: r.left + 290 * S.zoom, y: r.top + 590 * S.zoom, x2: r.left + 530 * S.zoom, y2: r.top + 670 * S.zoom }; });
    const v0 = await p.evaluate(() => S.doc.pages[0].v);
    await p.mouse.move(at2.x, at2.y); await p.mouse.down(); await p.mouse.move(at2.x2, at2.y2, { steps: 8 }); await p.mouse.up();
    await p.waitForFunction((v) => S.doc.pages[0].v !== v && pageEl(0).dataset.rkey, v0, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800));
    ok((await red()) === 0, "after Whiteout over it, the stamp is gone from the page");
    const txt = await p.evaluate(async () => (await call("pageText", 0)).map((s) => s.text).join(" "));
    ok(!/APPROVED/.test(txt) && /INVOICE/.test(txt), "…and its text is removed, not just covered");
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
  await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
}
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
