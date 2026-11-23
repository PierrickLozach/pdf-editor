// Word and LibreOffice documents in the editor (/app/), next to PDFs: one start screen, one toolbar, one
// Recent files list. The word processor is EdenText, served by this site. Checks, in Chromium (File System
// Access, as in Chrome and Edge), then Firefox and WebKit (downloads), and a phone:
//  - nothing is requested from another site, no Content-Security-Policy violation, no script error
//  - the word processor is only loaded once a document is opened; its AI assistant and dictation are off,
//    the frame gets no microphone; opened on its own it goes back to /app/; the old /write/ goes to /app/
//  - open a .docx (fictional fixture), type, Save writes into the same file; Recent files reopens it
//  - the unsaved copy: after a reload, its line in Recent files brings the changes back
//  - a .odt from the file input; Download copy as Word, LibreOffice and PDF
//  - a PDF and a document replace each other in the same editor
//  - Convert › Edit as a document opens the PDF's text in a new tab of the editor
//  - French: the start screen and the word processor in French; changing the language keeps the document
// Run: node docs.pw.mjs [site]   (default http://127.0.0.1:8787, the local site: cd site && npm run dev)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, firefox, webkit, devices } from "playwright";

const SITE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const APP = SITE + "/app/";
const HOST = new URL(SITE).hostname;
const fx = (n) => new URL(`../fixtures/${n}`, import.meta.url).pathname;
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdfe-docs-"));
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
const pm = (page) => page.frameLocator("#docFrame iframe").locator(".ProseMirror").first();
const frameText = (page) => pm(page).innerText();
async function typeAtEnd(page, text) {
  await pm(page).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type(text);
  await page.waitForFunction(() => DOCS.state.edDirty, null, { timeout: 10000 }).catch(() => {});
}
const ready = (page) => page.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
const docOpen = (page, name) => page.waitForFunction((n) => DOCS.isOpen() && (!n || DOCS.state.name === n), name || null, { timeout: 30000 });
const download = async (page, fn) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), fn()]); return { name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) }; };
const clean = (page) => page.evaluate(() => { if (window.DOCS) { DOCS.state.edDirty = false; DOCS.state.hostDirty = false; } if (typeof S !== "undefined") S.dirty = false; });

/* ---------------------------------------------------------------- Chromium: everything */
async function chromiumRun() {
  console.log("chromium");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: "en-US" });
  await ctx.addInitScript(() => { try { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); } catch (e) {} });
  const page = await ctx.newPage();
  const errs = [], outside = [];
  watch(ctx, page, errs, outside);
  page.on("dialog", (d) => d.accept());
  try {
    await page.goto(SITE + "/write/");
    ok(new URL(page.url()).pathname === "/app/", "the old /write/ address opens the editor");
    await page.goto(SITE + "/app/edentext/");
    ok(new URL(page.url()).pathname === "/app/", "the word processor opened on its own goes back to the editor");
    const cfg = await page.evaluate(() => fetch("/app/edentext/edentext.config.json").then((r) => r.json()));
    ok(cfg.ai && cfg.ai.enabled === false && cfg.dictation && cfg.dictation.enabled === false, "AI assistant and dictation off for the whole site");
    const emb = await page.evaluate(() => fetch("/app/edentext/embed.config.json").then((r) => r.json()));
    ok(JSON.stringify(emb.origins) === '["self"]', "only this site may drive the word processor");
    const hdr = await page.evaluate(async () => { const r = await fetch("/app/edentext/index.html"); return [r.headers.get("content-security-policy"), r.headers.get("x-frame-options")]; });
    ok(/connect-src 'self' data: blob:;/.test(hdr[0] || "") && /frame-ancestors 'self'/.test(hdr[0] || "") && hdr[1] === "SAMEORIGIN", "word processor: no connection to another site, framed only by this site");

    await ready(page);
    ok((await page.textContent("#empty h1")) === "Drop a PDF, Word or LibreOffice file here" && await page.isVisible("#btnNewDoc"), "one start screen for PDFs and documents");
    ok((await page.locator("#docFrame iframe").count()) === 0, "the word processor is not loaded for PDF users");
    ok((await page.getAttribute("#fileInput", "accept")).includes(".docx"), "Open accepts Word and LibreOffice files");

    // open a .docx with a file handle (the browser's private folder stands in for a file on the computer)
    await page.evaluate(async (b64) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle("garden-club.docx", { create: true });
      const w = await h.createWritable(); await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); await w.close();
      const f = await h.getFile(); f.__handle = h;
      await openFile(f);                                                    // the editor's own Open path
    }, fs.readFileSync(fx("garden-club.docx")).toString("base64"));
    await docOpen(page, "garden-club.docx");
    ok(/Garden club newsletter/.test(await frameText(page)), "the .docx is shown in the editor");
    ok(!(await page.getAttribute("#frameWrap", "id").catch(() => null)), "no separate page");
    ok((await page.textContent("#docName")) === "garden-club.docx" && (await page.textContent("#btnSave span")) === "Save (overwrites)", "toolbar: its name, Save writes into the file");
    ok(!(await page.isVisible('[data-tool="edit"]')) && !(await page.isVisible("#btnUndo")) && await page.isVisible("#btnDownload") && await page.isVisible("#btnDocClose"),
       "toolbar: PDF tools hidden, Download copy and Close shown");
    ok(!(await page.getAttribute("#docFrame iframe", "allow") || "").includes("microphone"), "no microphone for the frame");
    await typeAtEnd(page, " Tea is free.");
    ok((await page.textContent("#saveState")) === "Not saved", "changes: Not saved");
    await page.click("#btnSave");
    await page.waitForFunction(() => !DOCS.state.edDirty && document.querySelector("#saveState").textContent === "Saved", null, { timeout: 20000 }).catch(() => {});
    ok((await page.textContent("#saveState")) === "Saved", "Save: Saved");
    const disk = Buffer.from(await page.evaluate(async () => {
      const f = await (await (await navigator.storage.getDirectory()).getFileHandle("garden-club.docx")).getFile();
      const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s);
    }), "base64");
    const txt = docText(disk, "x.docx");
    ok(/Tea is free/.test(txt) && /spring meeting/.test(txt), "the file on disk has the old and the new text");

    // Recent files: the same list as PDFs
    await page.click("#btnDocClose");
    await page.waitForFunction(() => !DOCS.isOpen() && !document.body.classList.contains("doc-mode"));
    await page.waitForFunction(() => (document.querySelector("#recentFiles") || {}).textContent?.includes("garden-club.docx"), null, { timeout: 10000 }).catch(() => {});
    ok(await page.isVisible("#recentFiles") && (await page.textContent("#recentFiles")).includes("garden-club.docx"), "Recent files lists the document");
    await page.click('#recentFiles li:has-text("garden-club.docx") .rf-open');
    await docOpen(page, "garden-club.docx");
    ok(/Tea is free/.test(await frameText(page)), "Recent files reopens the saved file");

    // the unsaved copy, after a reload: its line in Recent files
    await typeAtEnd(page, " Bring gloves.");
    await page.evaluate(() => DOCS.keepCopy());
    await page.waitForFunction(() => DOCSTORE.get("keep", "recovery").then((r) => !!r), null, { timeout: 10000 }).catch(() => {});
    await clean(page);                                                     // no "leave this page?" in the test
    await page.reload();
    await ready(page);
    await page.waitForSelector("#recentFiles li.rf-unsaved", { timeout: 10000 }).catch(() => {});
    ok((await page.textContent("#recentFiles li.rf-unsaved").catch(() => "")).includes("garden-club.docx"), "Recent files: “Unsaved changes” on the document's line");
    await page.click("#recentFiles li.rf-unsaved .rf-open");
    await docOpen(page);
    ok(/Bring gloves/.test(await frameText(page)), "Resume brings the changes back");
    ok((await page.textContent("#saveState")) === "Not saved" && (await page.textContent("#btnSave span")) === "Save (overwrites)", "…still not saved, Save still writes into the file");
    await clean(page);

    // a .odt from the file input (no handle), Download copy in three formats
    await page.setInputFiles("#fileInput", fx("bakery-hours.odt"));
    await docOpen(page, "bakery-hours.odt");
    ok(/Bakery opening hours/.test(await frameText(page)), "the .odt is shown");
    for (const [i, ext] of [[0, "docx"], [1, "odt"], [2, "pdf"]]) {
      await page.click("#btnDownload");
      const f = await download(page, () => page.click(`#docDownloadMenu button:nth-child(${i + 1})`));
      const good = ext === "pdf" ? f.bytes.subarray(0, 5).toString() === "%PDF-" : /rye bread/.test(docText(f.bytes, f.name));
      ok(f.name === "bakery-hours." + ext && good, `Download copy › ${ext}: ${f.name}`);
    }

    // a PDF replaces the document, and a document the PDF: one file at a time, in the same editor
    await page.setInputFiles("#fileInput", fx("demo-invoice.pdf"));
    await page.waitForFunction(() => typeof S !== "undefined" && S.doc && S.doc.name === "demo-invoice.pdf" && !DOCS.isOpen(), null, { timeout: 30000 }).catch(() => {});
    ok(await page.evaluate(() => S.doc && S.doc.name === "demo-invoice.pdf" && !DOCS.isOpen() && !document.body.classList.contains("doc-mode")) && await page.isVisible('[data-tool="edit"]'),
       "a PDF opened over a document: the PDF tools are back");
    await page.setInputFiles("#fileInput", fx("garden-club.docx"));
    await docOpen(page, "garden-club.docx");
    ok(await page.evaluate(() => !S.doc && DOCS.isOpen()), "a document opened over a PDF: the PDF is closed");
    await clean(page);
    await page.click("#btnDocClose");
    await page.waitForFunction(() => !DOCS.isOpen());

    // Convert › Edit as a document: the PDF's text in a new tab of the editor
    await page.setInputFiles("#fileInput", fx("demo-invoice.pdf"));
    await page.waitForFunction(() => typeof S !== "undefined" && S.doc && S.doc.name === "demo-invoice.pdf", null, { timeout: 30000 });
    await page.click("#btnTools"); await page.click('#toolsMenu [data-k="convert"]');
    await page.waitForSelector("#convertDlg");
    await page.check('#convertDlg [value="docedit"]');
    const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 20000 }), page.click("#convertDlg .td-ok")]);
    watch(ctx, tab, errs, outside);
    await tab.waitForURL((u) => u.pathname === "/app/", { timeout: 30000 });
    await ready(tab);
    await docOpen(tab).catch(() => {});
    ok(/invoice/i.test(await frameText(tab).catch(() => "")) && (await tab.evaluate(() => DOCS.state.name)) === "demo-invoice.docx", "Convert › Edit as a document opens the PDF's text in a new tab");
    ok(await page.evaluate(() => S.doc && S.doc.name === "demo-invoice.pdf"), "…and the PDF stays open in its tab");
    await tab.close();
    await clean(page);

    // French; changing the language keeps the document and its changes
    await page.goto(APP + "?lang=fr");
    await ready(page);
    ok((await page.textContent("#btnOpen span")) === "Ouvrir" && (await page.textContent("#empty h1")) === "Déposez un PDF, un fichier Word ou LibreOffice ici", "start screen in French");
    await page.setInputFiles("#fileInput", fx("garden-club.docx"));
    await docOpen(page);
    const ribbon = await page.frameLocator("#docFrame iframe").locator("body").innerText();
    ok(/Accueil|Insertion|Fichier/.test(ribbon), "the word processor in French");
    await typeAtEnd(page, " Merci.");
    await page.click("#btnLang");
    await Promise.all([page.waitForURL((u) => u.pathname === "/app/" && !u.search.includes("lang"), { timeout: 20000 }), page.click('#langMenu button:has-text("English")')]);
    await ready(page);
    await docOpen(page).catch(() => {});
    ok((await page.textContent("#btnOpen span")) === "Open" && /Merci\./.test(await frameText(page).catch(() => "")) && (await page.textContent("#saveState")) === "Not saved",
       "back in English: the document is still open with its unsaved change");
    await clean(page);
    await page.evaluate(() => localStorage.removeItem("pdfe.lang"));
  } catch (e) { ok(false, "chromium: " + e.message); }
  ok(!outside.length, "nothing requested from another site" + (outside.length ? ": " + outside.slice(0, 5).join(" ") : ""));
  ok(!errs.length, "no error, no Content-Security-Policy violation" + (errs.length ? ": " + errs.slice(0, 5).join(" | ") : ""));

  // a phone: the toolbar fits, Download copy is reachable
  console.log("chromium phone");
  const pctx = await browser.newContext({ ...devices["iPhone 13"], acceptDownloads: true });
  const ph = await pctx.newPage();
  try {
    await ph.goto(APP);
    await ready(ph);
    await ph.setInputFiles("#fileInput", fx("garden-club.docx"));
    await docOpen(ph);
    const fits = await ph.evaluate(() => { const tb = document.getElementById("toolbar"); return tb.scrollWidth <= tb.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; });
    ok(fits, "phone: the toolbar fits, nothing scrolls sideways");
    const reach = await ph.evaluate(() => !!document.getElementById("btnDownload").offsetParent || !document.getElementById("btnMore").closest(".group").classList.contains("off"));
    ok(reach && await ph.isVisible("#btnSave"), "phone: Save and Download copy are reachable");
  } catch (e) { ok(false, "phone: " + e.message); }
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
    await page.goto(APP);
    await ready(page);
    await page.setInputFiles("#fileInput", fx("garden-club.docx"));
    await docOpen(page);
    ok(/Garden club newsletter/.test(await frameText(page)), "the .docx is shown in the editor");
    ok((await page.textContent("#btnSave span")) === "Save", "Save (a download in this browser)");
    await typeAtEnd(page, " Tea is free.");
    const f = await download(page, () => page.click("#btnSave"));
    ok(f.name === "garden-club.docx" && /Tea is free/.test(docText(f.bytes, f.name)), "Save downloads the edited .docx");
    await page.waitForFunction(() => document.querySelector("#saveState").textContent !== "Not saved", null, { timeout: 10000 }).catch(() => {});
    ok((await page.textContent("#saveState")) !== "Not saved", "…and the changes count as saved");
    await page.click("#btnDocClose");
    await page.waitForFunction(() => !DOCS.isOpen(), null, { timeout: 10000 }).catch(() => {});
    await page.click("#btnNewDoc");
    await page.waitForFunction(() => DOCS.state.name === "Untitled.docx", null, { timeout: 20000 }).catch(() => {});
    ok((await page.evaluate(() => DOCS.state.name)) === "Untitled.docx", "Start a new document");
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
