// Screenshots for the guides added on 24 Nov 2026 (site/pages/assets/guides/<name>-<lang>.webp):
// protect, numbers, watermark, convert, images, fill. Fictional files only (demo invoice, demo forms).
// Run with the local server: node guide-shots2.mjs [base url]; then convert the PNGs to WebP (q80) and delete them.
import fs from "node:fs";
import { chromium } from "playwright";
const B = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const OUT = new URL("../../site/pages/assets/guides/", import.meta.url).pathname;
const FIX = (f) => new URL("../fixtures/" + f, import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();

// a picture of the invoice's page, for "a PDF from pictures"
let scan = null;
{
  const c = await b.newContext(); const p = await c.newPage();
  await p.goto(B + "/app/"); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
  await p.setInputFiles("#fileInput", FIX("demo-invoice.pdf"));
  await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey, null, { timeout: 30000 });
  const png = await p.evaluate(async () => Array.from(new Uint8Array((await call("toImages", "jpg", 150, [0]))[0].bytes)));
  scan = "/tmp/receipt-photo.jpg"; fs.writeFileSync(scan, Buffer.from(png));
  await c.close();
}

for (const lang of ["en", "fr"]) {
  const c = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", locale: lang === "fr" ? "fr-FR" : "en-US" });
  await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
  await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
  const p = await c.newPage();
  const ready = () => p.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
  const open = async (file) => {
    await p.goto(B + "/app/"); await ready();
    await p.setInputFiles("#fileInput", file);
    await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey, null, { timeout: 30000 });
    await sleep(800);
  };
  const shot = async (name, away = true) => { if (away) await p.mouse.move(1435, 600); await sleep(600); await p.screenshot({ path: `${OUT}${name}-${lang}.png` }); console.log("  " + name + "-" + lang); };
  const tool = (k) => p.evaluate((k) => { TOOLS.run(k); }, k);
  const invoice = FIX("demo-invoice.pdf");

  // protect: the window, password typed twice
  await open(invoice);
  await tool("protect"); await p.waitForSelector("#protectDlg");
  await p.fill('#protectDlg input[name="pw"]', "lamp river orange 17"); await p.fill('#protectDlg input[name="pw2"]', "lamp river orange 17");
  await shot("protect"); await p.keyboard.press("Escape");

  // numbers: the window
  await open(invoice);
  await tool("numbers"); await p.waitForSelector("#numbersDlg");
  await p.selectOption('#numbersDlg select[name="format"]', "page");
  await shot("numbers"); await p.keyboard.press("Escape");

  // watermark: the page with DRAFT across it
  await open(invoice);
  await tool("watermark"); await p.waitForSelector("#watermarkDlg");
  await p.fill('#watermarkDlg input[name="text"]', lang === "fr" ? "BROUILLON" : "DRAFT");
  const v0 = await p.evaluate(() => S.doc.pages[0].v);
  await p.click("#watermarkDlg .td-ok");
  await p.waitForFunction((v0) => S.doc.pages[0].v !== v0 && pageEl(0).dataset.rkey, v0, { timeout: 30000 }); await sleep(1200);
  await shot("watermark");

  // convert: the window
  await open(invoice);
  await tool("convert"); await p.waitForSelector("#convertDlg");
  await shot("convert"); await p.keyboard.press("Escape");

  // images: a PDF made from a photo
  await p.goto(B + "/app/"); await ready();
  await p.setInputFiles("#imagesInput", scan);
  await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey, null, { timeout: 30000 }); await sleep(1200);
  await shot("images");

  // fill: Add text on the first line of a fictional form
  await open(FIX(`demo-form-${lang}.pdf`));
  await p.evaluate(() => setTool("add"));
  const [x, y] = await p.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return [r.left + 206 * S.zoom, r.top + 152 * S.zoom]; });
  await p.mouse.click(x, y); await p.waitForFunction(() => S.ed && S.ed.mode === "add");
  await p.keyboard.type("Alex Martin"); await sleep(400);
  await shot("fill", false); await p.keyboard.press("Escape");
  await c.close();
}
await b.close();
console.log("done");
