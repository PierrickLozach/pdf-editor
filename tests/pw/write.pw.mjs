// The document editor (/write/): Word and LibreOffice documents in EdenText, served by this site.
// Checks, in Chromium (File System Access, as in Chrome and Edge), then Firefox and WebKit (downloads):
//  - nothing is requested from another site, no Content-Security-Policy violation, no script error
//  - the AI assistant and dictation are off for the whole site (edentext.config.json) and the frame
//    gets no microphone; the word processor opened on its own goes back to /write/
//  - open a .docx (fictional fixture), type, Save writes into the same file; Recent files reopens it
//  - a .odt from the file input; Download copy as Word, LibreOffice and PDF
//  - the unsaved copy: after a reload, Resume brings the changes back
//  - a .docx dropped on the PDF editor opens here; Convert › Edit as a document opens the PDF's text here
//  - French: this page and the word processor in French; changing the language keeps the document
// Run: node write.pw.mjs [site]   (default http://127.0.0.1:8787, the local site: cd site && npm run dev)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, firefox, webkit } from "playwright";

const SITE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const HOST = new URL(SITE).hostname;
const fx = (n) => new URL(`../fixtures/${n}`, import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdfe-write-"));
/** the text of a .docx or .odt (its main XML part, tags removed) */
function docText(bytes, name) {
  const f = path.join(tmp, "x-" + Date.now() + path.extname(name));
  fs.writeFileSync(f, bytes);
  const part = /\.odt$/i.test(name) ? "content.xml" : "word/document.xml";
  try { return execFileSync("unzip", ["-p", f, part]).toString().replace(/<[^>]+>/g, " ").replace(/\s+/g, " "); }
  catch (e) { return ""; }
}

function watch(ctx, page, errs, outside) {
  ctx.on("request", (r) => {
    const u = r.url();
    if (/^(data|blob|about):/.test(u)) return;
    if (new URL(u).hostname !== HOST) outside.push(u);
  });
  page.on("pageerror", (e) => errs.push("page error: " + e.message));
  page.on("console", (m) => {
    const s = m.text();
    if (/Ignoring .x-frame-options. because of .frame-ancestors./i.test(s)) return;      // Firefox: a note, the stricter header wins
    if (/Content.Security.Policy|Content Security Policy/i.test(s)) errs.push("CSP: " + s);
    else if (m.type() === "error" && !/downloadable font|Failed to load resource: the server responded with a status of 404/.test(s)) errs.push(s);
  });
}
const frameText = (page) => page.frameLocator("#frameWrap iframe").locator(".ProseMirror").first().innerText();
async function typeAtEnd(page, text) {
  const pm = page.frameLocator("#frameWrap iframe").locator(".ProseMirror").first();
  await pm.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type(text);
  await page.waitForFunction(() => WRITE.S.edDirty, null, { timeout: 10000 }).catch(() => {});
}
const ready = (page) => page.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
const download = async (page, fn) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), fn()]); return { name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) }; };

/* ---------------------------------------------------------------- Chromium: everything */
async function chromiumRun() {
  console.log("chromium");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: "en-US" });
  const page = await ctx.newPage();
  const errs = [], outside = [];
  watch(ctx, page, errs, outside);
  page.on("dialog", (d) => d.accept());
  try {
    // the word processor on its own goes back to the document editor
    await page.goto(SITE + "/write/edentext/");
    ok(new URL(page.url()).pathname === "/write/", "the word processor opened on its own goes back to /write/");
    const cfg = await page.evaluate(() => fetch("/write/edentext/edentext.config.json").then((r) => r.json()));
    ok(cfg.ai && cfg.ai.enabled === false && cfg.dictation && cfg.dictation.enabled === false, "AI assistant and dictation off for the whole site");
    const emb = await page.evaluate(() => fetch("/write/edentext/embed.config.json").then((r) => r.json()));
    ok(JSON.stringify(emb.origins) === '["self"]', "only this site may drive the word processor");

    await ready(page);
    ok(await page.isVisible("#btnOpen2"), "start screen shown");
    const allow = await page.getAttribute("#frameWrap iframe", "allow");
    ok(!/microphone/.test(allow || ""), "no microphone for the frame");
    const hdr = await page.evaluate(async () => { const r = await fetch("/write/edentext/index.html"); return [r.headers.get("content-security-policy"), r.headers.get("x-frame-options")]; });
    ok(/connect-src 'self' data: blob:;/.test(hdr[0] || "") && /frame-ancestors 'self'/.test(hdr[0] || "") && hdr[1] === "SAMEORIGIN", "word processor: no connection to another site, framed only by this site");

    // open a .docx with a file handle (the browser's private folder stands in for a file on the computer)
    await page.evaluate(async (b64) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle("garden-club.docx", { create: true });
      const w = await h.createWritable(); await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close();
      await WRITE.openDoc(await h.getFile(), h);
    }, fs.readFileSync(fx("garden-club.docx")).toString("base64"));
    await page.waitForFunction(() => WRITE.S.open);
    ok(/Garden club newsletter/.test(await frameText(page)), "the .docx is shown");
    ok((await page.textContent("#btnSave span")) === "Save (overwrites)", "Save says it writes into the file");
    await typeAtEnd(page, " Tea is free.");
    ok((await page.textContent("#saveState")) === "Not saved", "changes: Not saved");
    await page.click("#btnSave");
    await page.waitForFunction(() => !WRITE.S.edDirty && document.querySelector("#saveState").textContent === "Saved", null, { timeout: 20000 }).catch(() => {});
    ok((await page.textContent("#saveState")) === "Saved", "Save: Saved");
    const disk = Buffer.from(await page.evaluate(async () => {
      const f = await (await (await navigator.storage.getDirectory()).getFileHandle("garden-club.docx")).getFile();
      const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s);
    }), "base64");
    const txt = docText(disk, "x.docx");
    ok(/Tea is free/.test(txt) && /spring meeting/.test(txt), "the file on disk has the old and the new text");

    // Recent files
    await page.click("#btnClose");
    await page.waitForFunction(() => !WRITE.S.open);
    ok((await page.textContent("#recentList")).includes("garden-club.docx"), "Recent files lists it");
    await page.click("#recentList .rf-open");
    await page.waitForFunction(() => WRITE.S.open && WRITE.S.name === "garden-club.docx", null, { timeout: 20000 });
    ok(/Tea is free/.test(await frameText(page)), "Recent files reopens the saved file");

    // the unsaved copy, after a reload
    await typeAtEnd(page, " Bring gloves.");
    await page.evaluate(() => WRITE.keepCopy());
    await page.waitForFunction(() => DOCSTORE.get("keep", "recovery").then((r) => !!r), null, { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => { WRITE.S.edDirty = false; WRITE.S.hostDirty = false; });     // no "leave this page?" in the test
    await page.reload();
    await ready(page);
    await page.waitForSelector("#recovery:not([hidden])", { timeout: 10000 }).catch(() => {});
    ok(await page.isVisible("#recovery"), "start screen offers the unsaved changes");
    await page.click("#btnResume");
    await page.waitForFunction(() => WRITE.S.open, null, { timeout: 20000 });
    ok(/Bring gloves/.test(await frameText(page)), "Resume brings the changes back");
    ok((await page.textContent("#saveState")) === "Not saved" && (await page.textContent("#btnSave span")) === "Save (overwrites)", "…still not saved, Save still writes into the file");
    await page.evaluate(() => { WRITE.S.edDirty = false; WRITE.S.hostDirty = false; });

    // a .odt from the file input (no handle), Download copy in three formats
    await page.evaluate(() => { window.showOpenFilePicker = undefined; });
    await page.setInputFiles("#fileInput", fx("bakery-hours.odt"));
    await page.waitForFunction(() => WRITE.S.name === "bakery-hours.odt", null, { timeout: 20000 });
    ok(/Bakery opening hours/.test(await frameText(page)), "the .odt is shown");
    for (const [i, ext] of [[0, "docx"], [1, "odt"], [2, "pdf"]]) {
      await page.click("#btnDownload");
      const f = await download(page, () => page.click(`#downloadMenu button:nth-child(${i + 1})`));
      const good = ext === "pdf" ? f.bytes.subarray(0, 5).toString() === "%PDF-" : /rye bread/.test(docText(f.bytes, f.name));
      ok(f.name === "bakery-hours." + ext && good, `Download copy › ${ext}: ${f.name}`);
    }

    // a .docx dropped on the PDF editor (here: its file input) opens in the document editor
    await page.goto(SITE + "/app/");
    await page.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
    ok(await page.isVisible(".to-docs a"), "PDF editor start screen: link to the document editor");
    await Promise.all([page.waitForURL(/\/write\//, { timeout: 20000 }), page.setInputFiles("#fileInput", fx("garden-club.docx"))]);
    await ready(page);
    await page.waitForFunction(() => WRITE.S.open, null, { timeout: 20000 }).catch(() => {});
    ok(/Garden club newsletter/.test(await frameText(page).catch(() => "")), "a .docx given to the PDF editor opens in the document editor");

    // Convert › Edit as a document: the PDF's text in a new tab
    await page.goto(SITE + "/app/");
    await page.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
    await page.setInputFiles("#fileInput", fx("demo-invoice.pdf"));
    await page.waitForFunction(() => typeof S !== "undefined" && S.doc && S.doc.name === "demo-invoice.pdf", null, { timeout: 30000 });
    await page.click("#btnTools"); await page.click('#toolsMenu [data-k="convert"]');
    await page.waitForSelector("#convertDlg");
    await page.check('#convertDlg [value="docedit"]');
    const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 20000 }), page.click("#convertDlg .td-ok")]);
    watch(ctx, tab, errs, outside);
    await tab.waitForURL(/\/write\//, { timeout: 30000 });
    await ready(tab);
    await tab.waitForFunction(() => WRITE.S.open, null, { timeout: 30000 }).catch(() => {});
    ok(/invoice/i.test(await frameText(tab).catch(() => "")) && (await tab.evaluate(() => WRITE.S.name)) === "demo-invoice.docx", "Convert › Edit as a document opens the PDF's text in a new tab");
    ok(await page.evaluate(() => S.doc && S.doc.name === "demo-invoice.pdf"), "…and the PDF stays open in its tab");
    await tab.close();

    // French; changing the language keeps the document and its changes
    await page.goto(SITE + "/write/?lang=fr");
    await ready(page);
    ok((await page.textContent("#btnOpen span")) === "Ouvrir" && (await page.textContent("#empty h1")) !== "Drop a Word or LibreOffice document here", "this page in French");
    await page.setInputFiles("#fileInput", fx("garden-club.docx"));
    await page.waitForFunction(() => WRITE.S.open, null, { timeout: 20000 });
    const ribbon = await page.frameLocator("#frameWrap iframe").locator("body").innerText();
    ok(/Accueil|Insertion|Fichier/.test(ribbon), "the word processor in French");
    await typeAtEnd(page, " Merci.");
    await page.click("#btnLang");
    await Promise.all([page.waitForURL((u) => u.pathname === "/write/" && !u.search.includes("lang"), { timeout: 20000 }), page.click('#langMenu button:has-text("English")')]);
    await ready(page);
    await page.waitForFunction(() => WRITE.S.open, null, { timeout: 20000 }).catch(() => {});
    ok((await page.textContent("#btnOpen span")) === "Open" && /Merci\./.test(await frameText(page).catch(() => "")) && (await page.textContent("#saveState")) === "Not saved",
       "back in English: the document is still open with its unsaved change");
    await page.evaluate(() => { WRITE.S.edDirty = false; WRITE.S.hostDirty = false; localStorage.removeItem("pdfe.lang"); });
  } catch (e) { ok(false, "chromium: " + e.message); }
  ok(!outside.length, "nothing requested from another site" + (outside.length ? ": " + outside.slice(0, 5).join(" ") : ""));
  ok(!errs.length, "no error, no Content-Security-Policy violation" + (errs.length ? ": " + errs.slice(0, 5).join(" | ") : ""));
  await browser.close();
}

/* ---------------------------------------------------------------- Firefox, WebKit: open, edit, Save downloads */
async function otherRun(type, name) {
  console.log(name);
  const browser = await type.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, locale: "en-US" });
  const page = await ctx.newPage();
  const errs = [], outside = [];
  watch(ctx, page, errs, outside);
  page.on("dialog", (d) => d.accept());
  try {
    await page.goto(SITE + "/write/");
    await ready(page);
    await page.setInputFiles("#fileInput", fx("garden-club.docx"));
    await page.waitForFunction(() => WRITE.S.open, null, { timeout: 30000 });
    ok(/Garden club newsletter/.test(await frameText(page)), "the .docx is shown");
    ok((await page.textContent("#btnSave span")) === "Save", "Save (a download in this browser)");
    await typeAtEnd(page, " Tea is free.");
    const f = await download(page, () => page.click("#btnSave"));
    ok(f.name === "garden-club.docx" && /Tea is free/.test(docText(f.bytes, f.name)), "Save downloads the edited .docx");
    await page.waitForFunction(() => document.querySelector("#saveState").textContent !== "Not saved", null, { timeout: 10000 }).catch(() => {});
    ok((await page.textContent("#saveState")) !== "Not saved", "…and the changes count as saved");
    await page.click("#btnNew");
    await page.waitForFunction(() => WRITE.S.name === "Untitled.docx", null, { timeout: 20000 }).catch(() => {});
    ok((await page.evaluate(() => WRITE.S.name)) === "Untitled.docx", "New document");
  } catch (e) { ok(false, name + ": " + e.message); }
  ok(!outside.length, "nothing requested from another site" + (outside.length ? ": " + outside.slice(0, 5).join(" ") : ""));
  ok(!errs.length, "no error, no Content-Security-Policy violation" + (errs.length ? ": " + errs.slice(0, 5).join(" | ") : ""));
  await browser.close();
}

await chromiumRun();
await otherRun(firefox, "firefox");
await otherRun(webkit, "webkit");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
