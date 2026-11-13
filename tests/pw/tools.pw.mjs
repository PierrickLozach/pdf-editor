// The Tools menu in a real browser: sign (draw, type, saved, placed once), redact (areas and a word,
// apply), OCR on a scan, split / extract, convert, protect, page numbers, watermark, a PDF from
// pictures. Every file a tool makes is checked with MuPDF in Node.
// Run: node tools.pw.mjs [chromium|firefox|webkit|all] [url]
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";
import * as mupdf from "../../web/vendor/mupdf/mupdf.js";

const which = process.argv[2] || "all";
const URL0 = process.argv[3] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (bytes) => { const d = mupdf.Document.openDocument(bytes, "application/pdf"); let t = ""; for (let i = 0; i < d.countPages(); i++) t += d.loadPage(i).toStructuredText().asText(); return t; };
const unzip = (b) => {                           // names of the files in a stored zip
  const out = []; let i = 0;
  while (i + 30 < b.length && b.readUInt32LE(i) === 0x04034b50) { const n = b.readUInt16LE(i + 26), sz = b.readUInt32LE(i + 18); out.push(b.slice(i + 30, i + 30 + n).toString()); i += 30 + n + b.readUInt16LE(i + 28) + sz; }
  return out;
};

async function run(name, engine) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US", acceptDownloads: true });
  await ctx.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); window.showSaveFilePicker = undefined; });   // files a tool makes are downloaded
  const page = await ctx.newPage();
  const errs = [], viol = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await ctx.exposeFunction("__v", (x) => viol.push(x));
  await ctx.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => window.__v(`${e.violatedDirective} ${e.blockedURI}`)));
  const waitFn = async (expr, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); } return false; };
  const idle = () => waitFn(`!document.body.classList.contains("busy")`);
  const find = (q) => page.evaluate((q) => call("find", q).then((h) => h.length), q);
  const exported = async () => Buffer.from(await page.evaluate(async () => { const b = await call("export"); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }), "base64");
  const tool = async (k) => { await page.click("#btnTools"); await page.click(`#toolsMenu [data-k="${k}"]`); };
  const download = async (fn) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), fn()]); return { name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) }; };
  const pageXY = async (x, y, pg = 0) => page.evaluate(([x, y, pg]) => { const r = pageEl(pg).getBoundingClientRect(); return [r.left + x * S.zoom, r.top + y * S.zoom]; }, [x, y, pg]);
  const openFresh = async () => { await page.evaluate(() => { S.dirty = false; }); await page.setInputFiles("#fileInput", pdf); await waitFn(`S.doc && S.doc.name === "demo-invoice.pdf" && pageEl(0).dataset.rkey`); await idle(); };

  try {
    await page.goto(URL0);
    await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
    ok(await page.isVisible("#btnFromImages"), "start screen: “Create a PDF from pictures”");
    await openFresh();
    await page.click("#btnTools");
    const items = await page.evaluate(() => [...document.querySelectorAll("#toolsMenu [data-k]")].map((b) => b.dataset.k));
    const names = await page.evaluate(() => [...document.querySelectorAll("#toolsMenu > button[data-k]")].map((b) => [...b.querySelector("b").childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
    const sorted = names.slice(0, -1).slice().sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    ok(items.length === 13 && items[items.length - 1] === "pro" && JSON.stringify(names.slice(0, -1)) === JSON.stringify(sorted), "Tools menu: all 13 tools, alphabetical, “PDF Editor Pro” last: " + names.join(", "));
    await page.keyboard.press("Escape");
    ok(await page.evaluate(() => document.querySelector("#toolsMenu").hidden), "Esc closes the menu");

    // ---------------------------------------------------------------- sign: draw
    await tool("sign");
    await page.waitForSelector("#signDlg .sig-pad");
    const pad = await page.evaluate(() => { const r = document.querySelector("#signDlg .sig-pad").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    await page.mouse.move(pad[0] + 40, pad[1] + pad[3] * 0.6); await page.mouse.down();
    for (let k = 1; k <= 24; k++) await page.mouse.move(pad[0] + 40 + k * 14, pad[1] + pad[3] * (0.6 - 0.25 * Math.sin(k / 3)));
    await page.mouse.up();
    await page.click("#signDlg .td-ok");
    ok(await waitFn(`S.tool === "image" && S.image && S.image.signature`), "draw a signature → placed like an image");
    await page.mouse.click(...await pageXY(380, 330));
    await waitFn(`PLACE.active`);
    await page.keyboard.press("Enter");
    ok(await waitFn(`!PLACE.active && S.tool === "edit"`), "signature added once, back to Edit text");
    let raw = (await exported()).toString("latin1");
    ok((raw.match(/\/SMask/g) || []).length >= 1, "the signature has a transparent background (soft mask)");
    // signature saved for next time; type one
    await tool("sign");
    await page.waitForSelector("#signDlg");
    ok(await page.evaluate(() => document.querySelectorAll("#signDlg .sig-use").length === 1), "the drawn signature is kept in this browser for next time");
    await page.click('#signDlg [data-tab="type"]');
    await page.fill("#signDlg .sig-name", "Jane Doe");
    ok(await waitFn(`document.querySelector('#signDlg .sig-preview canvas')`), "type a name: handwritten preview");
    await page.click("#signDlg .td-ok");
    await waitFn(`S.tool === "image" && S.image`);
    await page.mouse.click(...await pageXY(80, 600));
    await waitFn(`PLACE.active`); await page.keyboard.press("Enter");
    await waitFn(`!PLACE.active`);
    ok((await page.evaluate(() => JSON.parse(localStorage.getItem("pdfe.signatures") || "[]").length)) === 2, "two signatures remembered");
    await page.evaluate(() => S.dirty = false);

    // ---------------------------------------------------------------- redact: a word everywhere + an area
    await openFresh();
    await tool("redact");
    ok(await waitFn(`!document.querySelector('#redactBar').hidden && S.tool === "redact"`), "Redact: the redaction bar opens");
    await page.fill("#redactBar .rb-word", "2026");
    await page.click("#redactBar .rb-mark");
    ok(await waitFn(`document.querySelectorAll('.redact-mark').length === 2`), "“2026” marked everywhere (2 places)");
    await page.evaluate(() => { const v = document.querySelector("#viewer"); v.scrollTop = 40; }); await sleep(150);   // the area is not under the floating bar
    const a = await pageXY(48, 155), b2 = await pageXY(260, 182);
    await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b2, { steps: 6 }); await page.mouse.up();
    ok(await waitFn(`document.querySelectorAll('.redact-mark').length === 3`) && /3 areas marked/.test(await page.textContent("#redactBar .rb-count")), "an area dragged by hand: 3 marked");
    ok(await find("Blue Harbor Consulting") === 1, "nothing removed before “Apply”");
    await page.click("#redactBar .rb-apply");
    await page.waitForSelector("#modal:not([hidden])");
    await page.click("#modalOk");
    await idle();
    ok(await waitFn(`document.querySelector('#redactBar').hidden && S.tool === "edit"`), "applied: back to Edit text");
    raw = (await exported());
    const txt = textOf(raw);
    ok(!/2026/.test(txt) && !/Blue Harbor/.test(txt) && /NORTHWIND STUDIO/.test(txt) && /Total due/.test(txt), "redacted for good in the saved PDF; the rest is kept");

    // ---------------------------------------------------------------- split / extract
    await openFresh();
    await page.evaluate(async () => { for (let i = 0; i < 3; i++) await pageAction("duplicate", 0); });
    await idle();
    await tool("split");
    await page.waitForSelector("#splitDlg");
    await page.fill('#splitDlg [name="pages"]', "2-3");
    let f = await download(() => page.click("#splitDlg .td-ok"));
    ok(f.name === "demo-invoice p2-3.pdf" && mupdf.Document.openDocument(f.bytes, "application/pdf").countPages() === 2, "extract pages 2-3 → one 2-page PDF: " + f.name);
    await tool("split");
    await page.waitForSelector("#splitDlg");
    await page.check('#splitDlg [value="each"]');
    f = await download(() => page.click("#splitDlg .td-ok"));
    ok(f.name === "demo-invoice.zip" && unzip(f.bytes).length === 4, "one PDF per page → a .zip of 4 PDFs: " + unzip(f.bytes).join(", "));
    await tool("split");
    await page.waitForSelector("#splitDlg");
    await page.fill('#splitDlg [name="pages"]', "1-9");
    await page.click("#splitDlg .td-ok");
    ok(await waitFn(`!document.querySelector('#splitDlg .err').hidden && /1 to 4/.test(document.querySelector('#splitDlg .err').textContent)`), "impossible pages: clear message (" + (await page.textContent("#splitDlg .err")) + ")");
    await page.keyboard.press("Escape");

    // ---------------------------------------------------------------- convert
    await openFresh();
    await tool("convert"); await page.waitForSelector("#convertDlg");
    f = await download(() => page.click("#convertDlg .td-ok"));
    ok(f.name === "demo-invoice.docx" && f.bytes[0] === 0x50 && unzip(f.bytes).includes("word/document.xml"), "PDF → Word (.docx)");
    await tool("convert"); await page.waitForSelector("#convertDlg");
    await page.check('#convertDlg [value="png"]');
    f = await download(() => page.click("#convertDlg .td-ok"));
    ok(f.name === "demo-invoice.png" && f.bytes[1] === 0x50, "PDF → PNG (one page: one picture)");
    await tool("convert"); await page.waitForSelector("#convertDlg");
    await page.check('#convertDlg [value="txt"]');
    f = await download(() => page.click("#convertDlg .td-ok"));
    ok(/NORTHWIND STUDIO/.test(f.bytes.toString()), "PDF → text");

    // ---------------------------------------------------------------- protect
    await tool("protect"); await page.waitForSelector("#protectDlg");
    await page.fill('#protectDlg [name="pw"]', "open-sesame"); await page.fill('#protectDlg [name="pw2"]', "open-sesam");
    await page.click("#protectDlg .td-ok");
    ok(await waitFn(`/different/.test(document.querySelector('#protectDlg .err').textContent)`), "two different passwords: refused");
    await page.fill('#protectDlg [name="pw2"]', "open-sesame");
    f = await download(() => page.click("#protectDlg .td-ok"));
    const pd = mupdf.Document.openDocument(f.bytes, "application/pdf");
    ok(pd.needsPassword() && pd.authenticatePassword("open-sesame") > 0, "protected copy: needs the password to open");
    ok(await find("NORTHWIND") === 1 && !(await page.evaluate(() => S.dirty)), "the PDF open in the editor is unchanged");

    // ---------------------------------------------------------------- page numbers, watermark
    await page.evaluate(async () => { await pageAction("duplicate", 0); }); await idle();
    await tool("numbers"); await page.waitForSelector("#numbersDlg");
    await page.selectOption('#numbersDlg [name="format"]', "page");
    await page.click("#numbersDlg .td-ok"); await idle();
    ok(await find("Page 1 of 2") === 1 && await find("Page 2 of 2") === 1, "page numbers: “Page 1 of 2”, “Page 2 of 2”");
    await tool("watermark"); await page.waitForSelector("#watermarkDlg");
    await page.fill('#watermarkDlg [name="text"]', "DRAFT");
    await page.click("#watermarkDlg .td-ok"); await idle();
    ok(await find("DRAFT") === 2, "watermark “DRAFT” on both pages");
    await page.click("#btnUndo"); await idle();
    ok(await find("DRAFT") === 0 && await find("Page 1 of 2") === 1, "undo removes the watermark only");

    // ---------------------------------------------------------------- a PDF from pictures, then OCR
    const png = Buffer.from(await page.evaluate(async () => { const [im] = await call("toImages", "png", 200); return [...im.bytes]; }));
    await page.evaluate(() => { S.dirty = false; });
    await page.setInputFiles("#imagesInput", [{ name: "scan.png", mimeType: "image/png", buffer: png }, { name: "scan2.png", mimeType: "image/png", buffer: png }]);
    ok(await waitFn(`S.doc && S.doc.name === "scan.pdf" && S.doc.pages.length === 2`), "Create a PDF from 2 pictures: a 2-page PDF");
    await idle();
    ok(await find("Harbour Street") === 0, "the scan has no text yet");
    await tool("ocr"); await page.waitForSelector("#ocrDlg");
    ok(/No page of this PDF has text/.test(await page.textContent("#ocrDlg")), "OCR: the scanned pages are detected");
    await page.click("#ocrDlg .td-ok");
    ok(await waitFn(`/searched/.test(document.querySelector('#toast').textContent)`, 120000), "OCR done: " + (await page.textContent("#toast")));
    ok(await find("Harbour Street") === 2, "the scan is now searchable, on both pages");
    ok(/Harbour Street/.test(textOf(await exported())), "…in the saved PDF too (other readers)");

    ok(viol.length === 0, "no security-policy violation " + viol.slice(0, 3).join(" | "));
    ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
  } catch (e) {
    fails++; console.log(`  FAIL [${name}] exception: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `/tmp/pdfe-site/tools-${name}-failure.png` }).catch(() => {});
  }
  await browser.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  return fails;
}

let total = 0;
for (const [n, e] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) if (which === "all" || which === n) total += await run(n, e);
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
