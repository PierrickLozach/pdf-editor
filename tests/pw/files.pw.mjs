// Working with files on the computer, in Chromium (File System Access API, as in Chrome and Edge):
// open a PDF, edit, Save writes into the same file on disk; Recent files reopens it; a file that
// disappeared is removed from the list; PDFs over the size limit are explained; and the one-time
// rescue of PDFs left from the removed accounts ("My PDFs") downloads them and cleans up.
// Run: node files.pw.mjs [url]   (default: the local site, http://localhost:8787/app/)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox } from "playwright";

const URL0 = process.argv[2] || "http://localhost:8787/app/";
const fx = (n) => new URL(`../fixtures/${n}`, import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfe-files-"));
const work = path.join(dir, "invoice.pdf");
fs.copyFileSync(fx("demo-invoice.pdf"), work);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/downloadable font|Refused to apply a stylesheet/.test(m.text())) errs.push(m.text()); });
const waitFn = async (expr, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(100); } return false; };
const ready = () => waitFn(`document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait')`, 60000);
const docReady = () => waitFn(`S.doc && S.spans[S.doc.pages[0].v] && pageEl(0).dataset.rkey && !S.pending`);
const editLine = async (from, to) => {
  const sp = await page.evaluate((t) => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === t); if (!s) return null; const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 4) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; }, from);
  if (!sp) return false;
  await page.mouse.click(sp.x, sp.y);
  await waitFn(`S.ed && document.activeElement === S.ed.box`);
  await page.evaluate(() => document.getSelection().selectAllChildren(S.ed.box));
  await page.keyboard.insertText(to);
  await page.keyboard.press("Enter");
  return waitFn(`!S.ed && !S.pending`);
};

// what a file in the test's private folder contains: read in the page, searched with a separate engine in Node
import { Engine } from "../../web/engine.js";
const webDir = new URL("../../web/", import.meta.url).pathname;
const nodeEngine = () => new Engine({ manifest: JSON.parse(fs.readFileSync(webDir + "fonts/fonts.json", "utf8")), fetchBytes: async (s) => new Uint8Array(fs.readFileSync(webDir + "fonts/" + s.file)) });
async function onDisk(name, ...texts) {
  const b64 = await page.evaluate(async (n) => {
    const b = new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile()).arrayBuffer());
    let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s);
  }, name);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const e = nodeEngine(); e.open(bytes, name);
  return { size: bytes.length, found: texts.map((t) => e.find(t).length) };
}
const find = (q) => page.evaluate((q) => call("find", q).then((h) => h.length), q);

try {
  await page.goto(URL0);
  await ready();
  ok(await page.evaluate(() => FILES.supported), "this browser can save into files (File System Access)");
  ok(/250 MB/.test(await page.textContent("#sizeNote")) && /replace your file or save a new one/.test(await page.textContent("#sizeNote")), "start screen: “" + (await page.textContent("#sizeNote")) + "”");
  ok(await page.evaluate(() => { const a = document.querySelector("#toolbar .brand a.logo"); return a && a.getAttribute("href") === "/"; }), "the logo in the toolbar links to the home page");
  ok(await page.evaluate(() => { const a = document.querySelector("#homeLink a"); return a && a.getAttribute("href") === "/" && /Home page/.test(a.textContent); }), "the start screen has a link back to the home page");
  ok(await page.evaluate(() => !document.querySelector("#btnSignIn, #acctArea, #myPdfs, #acctHint")), "no account interface left");

  // ---------------------------------------------------------------- open with Open (file picker)
  // a real handle: Chromium gives one for a file the test writes in the origin-private file system,
  // which behaves like a file on disk (same API: getFile, createWritable, isSameEntry, permissions)
  await page.evaluate(async (b64) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle("invoice.pdf", { create: true });
    const w = await h.createWritable();
    const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await w.write(u); await w.close();
    window.__disk = h;
    window.showOpenFilePicker = async () => [h];
  }, fs.readFileSync(work).toString("base64"));
  await page.click("#btnOpen");
  await docReady();
  ok((await page.evaluate(() => S.doc.name)) === "invoice.pdf" && await page.evaluate(() => !!FILES.handle), "Open: the PDF is opened together with its file");
  ok(await waitFn(`document.querySelector('#saveState').textContent === "Saved"`), "indicator: “Saved”");
  ok(await editLine("14 Harbour Street", "27 Mill Lane"), "text edited");
  ok((await page.textContent("#saveState")) === "Not saved", "after the edit: “Not saved”");
  const downloads = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  ok(await waitFn(`!document.querySelector('#saveDlg').hidden`), "⌘S asks: replace the file or save a new one");
  ok(/Replace “invoice\.pdf”/.test(await page.textContent("#saveDlg .sd-replace")) && /new file/.test(await page.textContent("#saveDlg .sd-new")), "…buttons: “" + (await page.textContent("#saveDlg .sd-replace")) + "”, “" + (await page.textContent("#saveDlg .sd-new")) + "”");
  await page.click("#saveDlg .sd-cancel");
  ok(await waitFn(`document.querySelector('#saveDlg').hidden && S.dirty`), "Cancel: nothing saved");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await waitFn(`!document.querySelector('#saveDlg').hidden`);
  await page.click("#saveDlg .sd-replace");
  ok(await waitFn(`!S.dirty && document.querySelector('#saveState').textContent === "Saved"`), "“Replace”: “Saved”");
  ok(/Saved in “invoice\.pdf”/.test(await page.textContent("#toast")), "message: " + (await page.textContent("#toast")));
  await sleep(500);
  ok(downloads.length === 0, "nothing downloaded: the file itself was saved");
  const disk = await onDisk("invoice.pdf", "27 Mill Lane", "14 Harbour Street");
  ok(disk.found[0] === 1 && disk.found[1] === 0, `the file on disk now contains the edit (${disk.size} bytes)`);

  // ---------------------------------------------------------------- recent files
  await page.reload(); await ready();
  ok(await waitFn(`!document.querySelector('#recentFiles').hidden && document.querySelectorAll('#recentFiles li').length === 1`), "Recent files: the file is listed after a reload");
  ok((await page.textContent("#recentFiles .rf-name")) === "invoice.pdf", "…by its name");
  // as after a browser restart: the stored file has no permission yet; record what the editor asks for
  await page.evaluate(() => {
    window.__asked = [];
    const P = FileSystemHandle.prototype, q = P.queryPermission, r = P.requestPermission;
    window.__restorePerm = () => { P.queryPermission = q; P.requestPermission = r; };
    P.queryPermission = async function (o) { return "prompt"; };
    P.requestPermission = async function (o) { window.__asked.push(o && o.mode); return "granted"; };
  });
  await page.click("#recentFiles .rf-open");
  await docReady();
  ok(await find("27 Mill Lane") === 1, "reopened from Recent files: the saved edit is there");
  const asked = await page.evaluate(() => window.__asked.slice());
  ok(asked.length === 1 && asked[0] === "read", "opening a recent file asks the browser only to VIEW it, not to edit it: " + JSON.stringify(asked));
  await page.evaluate(() => { window.__asked.length = 0; S.dirty = true; });
  await page.click("#btnSave");
  await waitFn(`!document.querySelector('#saveDlg').hidden`);
  await page.click("#saveDlg .sd-cancel");
  ok((await page.evaluate(() => window.__asked.length)) === 0, "…nothing more is asked unless the person saves into it");
  await page.evaluate(() => { window.__restorePerm(); S.dirty = false; });
  ok(await editLine("BS1 4QA BRISTOL", "BA1 1LZ BATH"), "second edit");
  await page.click("#btnSave");
  await waitFn(`!document.querySelector('#saveDlg').hidden`);
  await page.check("#saveDlgOnce");
  await page.click("#saveDlg .sd-replace");
  ok(await waitFn(`!S.dirty`), "Save again (Replace, “Don't ask again for this PDF”)");
  const disk2 = (await onDisk("invoice.pdf", "BA1 1LZ BATH")).found[0];
  ok(disk2 === 1, "the same file holds both edits");
  // "don't ask again": the next save goes straight into the file
  await page.evaluate(() => { S.dirty = true; });
  await page.click("#btnSave");
  ok(await waitFn(`!S.dirty`) && await page.evaluate(() => document.querySelector('#saveDlg').hidden), "after “Don't ask again”: Save writes without asking");
  // save as a new file: the original stays as it was, later saves go to the new file
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    window.showSaveFilePicker = async (o) => { window.__suggested = o.suggestedName; return root.getFileHandle("invoice-copy.pdf", { create: true }); };
  });
  ok(await editLine("BA1 1LZ BATH", "OX1 2JD OXFORD"), "third edit (before saving as a new file)");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+s" : "Control+Shift+s");
  ok(await waitFn(`!S.dirty && /invoice-copy\.pdf/.test(document.querySelector('#toast').textContent)`), "⇧⌘S saves as a new file: " + (await page.textContent("#toast")));
  ok((await page.evaluate(() => window.__suggested)) === "invoice.pdf", "the new file is proposed under the same name, without “(edited)”");
  const both = { "invoice.pdf": (await onDisk("invoice.pdf", "OX1 2JD OXFORD")).found[0], "invoice-copy.pdf": (await onDisk("invoice-copy.pdf", "OX1 2JD OXFORD")).found[0] };
  ok(both["invoice.pdf"] === 0 && both["invoice-copy.pdf"] === 1, "the original is unchanged, the new file has the edit " + JSON.stringify(both));
  await page.reload(); await ready();
  // a stored list never contains the document itself
  const rec = await page.evaluate(async () => { const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-files"); q.onsuccess = () => r(q.result); }); return new Promise((r) => { const q = d.transaction("recent").objectStore("recent").getAll(); q.onsuccess = () => r(q.result.map((x) => ({ keys: Object.keys(x).sort().join(","), kind: x.handle && x.handle.kind }))); }); });
  ok(rec.length === 2 && rec.every((r) => r.keys === "handle,id,name,time" && r.kind === "file"), "the list keeps references to the files (original and new one), never copies");
  // the file disappears
  await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry("invoice-copy.pdf"); });
  await page.click("#recentFiles li:first-child .rf-open");
  ok(await waitFn(`/moved or deleted/.test(document.querySelector('#toast').textContent) && document.querySelectorAll('#recentFiles li').length === 1`), "a deleted file: clear message, removed from the list");

  // ---------------------------------------------------------------- a file without a handle: Save makes a copy
  await page.setInputFiles("#fileInput", fx("demo-invoice.pdf"));
  await docReady();
  ok(await page.evaluate(() => !FILES.handle), "a PDF given without access to its file (old-style picker)");
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  await editLine("NORTHWIND STUDIO", "SOUTHWIND STUDIO");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSave")]);
  ok(dl.suggestedFilename() === "demo-invoice.pdf", "Save downloads the edited PDF under its own name: " + dl.suggestedFilename());

  // ---------------------------------------------------------------- size limit
  await page.evaluate(() => { FILES.maxBytes = 1024 * 1024; });                     // simulate 1 MB
  await page.evaluate(() => { S.dirty = false; });
  await page.setInputFiles("#fileInput", fx("photo.pdf"));
  ok(await waitFn(`!document.querySelector('#modal').hidden && /too large/.test(document.querySelector('#modalTitle').textContent)`), "a PDF over the limit is explained before opening");
  const msg = await page.textContent("#modalText");
  ok(/photo\.pdf” is 4\.6 MB; the editor works with PDFs up to 1 MB/.test(msg) && /Preview/.test(msg) && /150–200 dpi/.test(msg), "…with its size, the limit and how to make it smaller");
  await page.click("#modalOk");
  ok(await page.evaluate(() => S.doc && S.doc.name === "demo-invoice.pdf"), "the open PDF is untouched");
  await page.evaluate(() => { FILES.maxBytes = 250 * 1024 * 1024; });
  ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
} catch (e) {
  fails++; console.log("  FAIL exception: " + e.message.split("\n")[0]);
  await page.screenshot({ path: "/tmp/pdfe-site/files-failure.png" }).catch(() => {});
}
await ctx.close();

/* ------------------------------------------------------------------ rescue of the old "My PDFs" */
console.log("\nPDFs left from the removed accounts");
{
  const c2 = await browser.newContext({ acceptDownloads: true });
  await c2.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
  const p = await c2.newPage();
  const cdp = await c2.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  const w = async (expr, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await p.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(100); } return false; };
  await p.goto(URL0);
  await w(`document.body.classList.contains('engine-ready')`, 60000);
  ok(await p.evaluate(() => !document.querySelector("#legacyBox")), "someone who never had an account sees nothing");
  // simulate an old account with 2 PDFs (the old vault code is still served for this purpose)
  await p.addScriptTag({ url: "legacy/vault.js" });
  await p.evaluate(async (b64) => {
    const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await Vault.create("Old user");
    await Vault.save(u, "kept-1.pdf"); await Vault.save(u, "kept-2.pdf");
    Vault.signOut();
  }, fs.readFileSync(fx("demo-invoice.pdf")).toString("base64"));
  await p.reload();
  ok(await w(`document.querySelector('#legacyBox') && /2 PDFs saved in “My PDFs”/.test(document.querySelector('#legacyBox').textContent)`), "an old account's PDFs are announced: “2 PDFs saved in “My PDFs” are still in this browser.”");
  const got = [];
  p.on("download", (d) => got.push(d.suggestedFilename()));
  await p.click("#legacyBox .lg-dl");
  await w(`!document.querySelector('#legacyBox')`, 20000); await sleep(1500);
  ok(got.length === 2, "“Download my PDFs”: one passkey sign-in, both downloaded: " + got.join(", "));
  const gone = await p.evaluate(() => new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); let created = false; q.onupgradeneeded = () => { created = true; }; q.onsuccess = () => { q.result.close(); if (created) indexedDB.deleteDatabase("pdf-editor-vault"); r(created); }; }));
  ok(gone, "then the old encrypted storage is erased");
  await p.reload();
  ok(await w(`document.body.classList.contains('engine-ready')`, 60000) && await p.evaluate(() => !document.querySelector("#legacyBox")), "and the message does not come back");
  await c2.close();
}

/* ------------------------------------------------------------------ Firefox: no file access */
console.log("\nFirefox (no File System Access)");
{
  const fb = await firefox.launch(); const c3 = await fb.newContext({ acceptDownloads: true }); const p = await c3.newPage();
  await c3.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
  await p.goto(URL0);
  await p.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
  ok(/Save downloads the edited PDF/.test(await p.textContent("#sizeNote")) && await p.evaluate(() => document.querySelector("#recentFiles") === null || document.querySelector("#recentFiles").hidden), "start screen says Save downloads; no Recent files");
  await p.setInputFiles("#fileInput", fx("demo-invoice.pdf"));
  await p.waitForFunction(() => S.doc && S.spans[S.doc.pages[0].v]);
  await p.evaluate(() => { S.dirty = true; });
  const [d] = await Promise.all([p.waitForEvent("download"), p.click("#btnSave")]);
  ok(d.suggestedFilename() === "demo-invoice.pdf", "Save downloads the edited PDF under its own name");
  await fb.close();
}
await browser.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : "\nALL OK");
process.exit(fails ? 1 : 0);
