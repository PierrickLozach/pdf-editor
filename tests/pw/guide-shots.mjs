// Screenshots for the guides (site/pages/assets/guides/<name>-<lang>.webp), on the fictional test invoice.
// Run with the local server: node guide-shots.mjs [base url]
import fs from "node:fs";
import { chromium } from "playwright";
const B = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const OUT = new URL("../../site/pages/assets/guides/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const INVOICE = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a scanned version of the invoice (a picture of its page), for the OCR screenshot
async function scanned(browser) {
  const c = await browser.newContext(); const p = await c.newPage();
  await p.goto(B + "/app/"); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
  await p.setInputFiles("#fileInput", INVOICE);
  await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey, null, { timeout: 30000 });
  const png = await p.evaluate(async () => { const r = await call("toImages", "png", 150, [0]); return Array.from(new Uint8Array(r[0].bytes)); })
    .catch((e) => { console.log("scan failed:", e.message); return null; });
  await c.close();
  return png ? Buffer.from(png) : null;
}

const b = await chromium.launch();
console.log("making the scan…");
const scanPng = await Promise.race([scanned(b), sleep(45000).then(() => { console.log("scan timed out"); return null; })]);
console.log("scan:", scanPng ? scanPng.length + " bytes" : "none");
for (const lang of ["en", "fr"]) {
  const c = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", locale: lang === "fr" ? "fr-FR" : "en-US" });
  await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); localStorage.removeItem("pdfe.signatures"); });
  await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
  const p = await c.newPage();
  const open = async (file) => {
    console.log("  open", lang);
    await p.goto(B + "/app/"); await p.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
    await p.setInputFiles("#fileInput", file);
    await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey && S.spans && S.spans[S.doc.pages[0].v], null, { timeout: 30000 });
    await sleep(700);
  };
  const shot = async (name) => { await sleep(500); await p.screenshot({ path: `${OUT}${name}-${lang}.png` }); console.log("  " + name + "-" + lang); };
  const at = (t) => p.evaluate((t) => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === t), r = pageEl(0).getBoundingClientRect();
    return [r.left + (s.tbox[0] + s.tbox[2]) / 2 * S.zoom, r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom]; }, t);
  const tool = (k) => p.evaluate((k) => { TOOLS.run(k); }, k);      // do not wait: the windows resolve only when closed

  // 1. edit text: the amount open for editing
  await open(INVOICE);
  await p.mouse.click(...(await at("2,100.00"))); await p.waitForFunction(() => S.ed);
  await p.keyboard.press("End"); for (let i = 0; i < 8; i++) await p.keyboard.press("Backspace"); await p.keyboard.type("2,450.00");
  await shot("edit-text"); await p.keyboard.press("Escape");

  // 2. sign: the signature window, a name typed
  await open(INVOICE);
  await tool("sign"); await p.waitForSelector(".sig-tabs");
  await p.click('.sig-tabs [data-tab="type"]'); await p.fill(".sig-name", "Alex Martin"); await sleep(600);
  await shot("sign"); await p.keyboard.press("Escape");

  // 3. redact: two areas marked
  await open(INVOICE);
  await tool("redact"); await p.waitForSelector("#redactBar:not([hidden])");
  const drag = async (x0, y0, x1, y1) => {
    const [a, z] = await p.evaluate(([x0, y0, x1, y1]) => { const r = pageEl(0).getBoundingClientRect(); return [[r.left + x0 * S.zoom, r.top + y0 * S.zoom], [r.left + x1 * S.zoom, r.top + y1 * S.zoom]]; }, [x0, y0, x1, y1]);
    await p.mouse.move(...a); await p.mouse.down(); await p.mouse.move(...z, { steps: 6 }); await p.mouse.up(); await sleep(300);
  };
  const r1 = await p.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => /Blue Harbor/.test(x.text)); return s.tbox; });
  const r2 = await p.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => /Riverside/.test(x.text)); return s.tbox; });
  await drag(r1[0] - 3, r1[1] - 2, r1[2] + 3, r1[3] + 2);
  await p.fill(".rb-word", "BS1 4QA"); await p.click(".rb-mark"); await sleep(500);
  console.log("    marks:", await p.evaluate(() => REDACT.marks.length));
  await shot("redact"); await p.keyboard.press("Escape");

  // 4. OCR: the dialog, on the scanned invoice
  if (scanPng) {
    await p.goto(B + "/app/"); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
    fs.writeFileSync("/tmp/scan-invoice.png", scanPng);
    await p.setInputFiles("#imagesInput", "/tmp/scan-invoice.png");
    await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey, null, { timeout: 30000 }); await sleep(800);
    await tool("ocr"); await p.waitForSelector("#ocrDlg"); await shot("ocr"); await p.keyboard.press("Escape");
  }

  // 5. reduce: the dialog
  await open(INVOICE);
  await tool("reduce"); await sleep(700); await shot("reduce"); await p.keyboard.press("Escape");

  // 6. pages: the thumbnail panel with one page's buttons shown
  await open(INVOICE);
  const th = await p.locator("#thumbs .thumb").first().boundingBox();
  await p.mouse.move(th.x + th.width / 2, th.y + th.height / 2); await sleep(500);
  await shot("pages");
  await c.close();
}
await b.close();
console.log("done");
