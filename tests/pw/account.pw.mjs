// Accounts and "My PDFs", as a user does it, in a real browser with a passkey:
// create an account (passkey), add a PDF, open it, edit it, save it, reload, open it again and
// check the edit is there; save again (versions), open an older version; sign out (files locked),
// sign in again with the passkey; download; rename; delete a file; delete the account.
// Chromium uses a virtual passkey authenticator (with the PRF extension, as on real devices).
// Run: node account.pw.mjs [url]   (default: the local site, http://localhost:8787/app/)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const URL0 = process.argv[2] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;     // fictional invoice
const OUT = "/tmp/pdfe-site";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US", acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/downloadable font/.test(m.text())) errs.push(m.text()); });
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
const waitFn = async (expr, timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(100); }
  return false;
};
const ready = () => waitFn(`document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait') && document.querySelector('#acctArea')`, 60000);
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
const found = (q) => page.evaluate((q) => call("find", q).then((h) => h.length), q);

try {
  await page.goto(URL0);
  await ready();
  await page.evaluate(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
  ok(await page.isVisible("#btnSignIn") && await page.isVisible("#acctHint"), "signed out: “Sign in” in the toolbar, an invitation to create an account");

  // ---------------------------------------------------------------- create the account
  await page.click("#hintCreate");
  await page.waitForSelector("#authDlg:not([hidden])");
  await page.click("#authCreateForm button[type=submit]");
  ok(await page.evaluate(() => !document.querySelector("#authName").validity.valid), "a name is required");
  await page.fill("#authName", "Marie Dupont");
  await page.click("#authCreateForm button[type=submit]");
  ok(await waitFn(`Vault.account && Vault.account.name === "Marie Dupont" && document.querySelector('#authDlg').hidden`, 20000), "account created with a passkey");
  const creds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  ok(creds.length === 1 && creds[0].isResidentCredential, "one passkey on the device, discoverable (no user name to type)");
  ok((await page.textContent(".acct-avatar")).trim() === "MD", "toolbar shows the account (MD)");
  ok(await waitFn(`!document.querySelector('#myPdfs').hidden && !document.querySelector('#mpEmpty').hidden`), "“My PDFs” shown, empty");

  // ---------------------------------------------------------------- add a PDF, open it, edit it, save it
  await page.setInputFiles("#mpInput", pdf);
  ok(await waitFn(`document.querySelectorAll('#mpList .mp-item').length === 1`), "PDF added to My PDFs");
  ok((await page.textContent("#mpList .mp-name")) === "demo-invoice.pdf", "listed by its name");
  const stored = await page.evaluate(async () => {
    const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); });
    const all = await new Promise((r) => { const q = d.transaction("blobs").objectStore("blobs").getAll(); q.onsuccess = () => r(q.result); });
    const files = await new Promise((r) => { const q = d.transaction("files").objectStore("files").getAll(); q.onsuccess = () => r(q.result); });
    const b = new Uint8Array(all[0]);
    return { head: String.fromCharCode(...b.slice(0, 5)), nameInClear: JSON.stringify(files).includes("demo-invoice") };
  });
  ok(stored.head !== "%PDF-" && !stored.nameInClear, "stored encrypted: neither the PDF nor its name is readable in the browser storage");
  await page.click("#mpList .mp-open");
  await docReady();
  ok((await page.evaluate(() => S.doc.name)) === "demo-invoice.pdf" && (await page.textContent("#saveState")) === "Saved in My PDFs", "opened from My PDFs (“Saved in My PDFs”)");
  ok(await editLine("14 Harbour Street", "27 Mill Lane"), "text edited");
  ok((await page.textContent("#saveState")) === "Not saved", "after the edit: “Not saved”");
  await page.click("#btnSave");
  ok(await waitFn(`document.querySelector('#saveState').textContent === "Saved in My PDFs" && !S.dirty`), "Save: “Saved in My PDFs”");
  await page.screenshot({ path: `${OUT}/account-editing.png` });

  // ---------------------------------------------------------------- reload: still signed in, the edit is kept
  await page.reload();
  await ready();
  ok(await waitFn(`Vault.account && Vault.account.name === "Marie Dupont"`), "after a reload: still signed in (same tab, no passkey prompt)");
  await page.evaluate(() => call("discard"));
  await page.reload(); await ready();
  await waitFn(`document.querySelectorAll('#mpList .mp-item').length === 1`);
  ok(/2 versions/.test(await page.textContent("#mpList .mp-meta")), "the file shows 2 versions");
  await page.click("#mpList .mp-open");
  await docReady();
  ok(await found("27 Mill Lane") === 1 && await found("14 Harbour Street") === 0, "opened again: the saved edit is there");

  // second edit + Ctrl/Cmd+S
  ok(await editLine("BS1 4QA BRISTOL", "BA1 1LZ BATH"), "second edit");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  ok(await waitFn(`!S.dirty && document.querySelector('#saveState').textContent === "Saved in My PDFs"`), "⌘S saves to My PDFs too");

  // ---------------------------------------------------------------- versions
  await page.click("#acctBtn"); await page.click("#mMyPdfs");
  await waitFn(`!document.querySelector('#myPdfs').hidden && document.querySelectorAll('#mpList .mp-item').length === 1`);
  ok(await waitFn(`/3 versions/.test(document.querySelector("#mpList .mp-meta").textContent)`, 5000), "3 versions kept: " + await page.textContent("#mpList .mp-meta"));
  await page.click("#mpList .mp-more");
  await page.click('.mp-menu [data-a="versions"]');
  await page.waitForSelector("#versionsDlg:not([hidden])");
  ok(await page.evaluate(() => document.querySelectorAll("#versionsDlg li").length) === 3, "previous versions listed");
  await page.click("#versionsDlg li:last-child button");
  await docReady();
  ok(await found("14 Harbour Street") === 1 && await found("27 Mill Lane") === 0, "the original version opens (nothing lost)");

  // ---------------------------------------------------------------- download the current version
  await page.evaluate(() => { S.dirty = false; });
  await page.click("#acctBtn"); await page.click("#mMyPdfs");
  await waitFn(`document.querySelectorAll('#mpList .mp-item').length === 1`);
  await page.click("#mpList .mp-more");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.mp-menu [data-a="download"]')]);
  const dlBytes = fs.readFileSync(await dl.path());
  ok(dl.suggestedFilename() === "demo-invoice.pdf" && dlBytes.slice(0, 5).toString() === "%PDF-", "download gives a normal PDF");
  const check = await page.evaluate(async (b64) => {
    const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    await call("open", u, "check.pdf");
    const r = [await call("find", "27 Mill Lane"), await call("find", "BA1 1LZ BATH")].map((h) => h.length);
    await call("discard");
    return r;
  }, dlBytes.toString("base64"));
  ok(check[0] === 1 && check[1] === 1, "the downloaded PDF has both edits");

  // ---------------------------------------------------------------- sign out: locked; sign in again
  await page.reload(); await ready();
  await page.click("#acctBtn"); await page.click("#mSignOut");
  ok(await waitFn(`!Vault.account && document.querySelector('#btnSignIn') && document.querySelector('#myPdfs').hidden`), "signed out: My PDFs hidden");
  ok(await page.evaluate(() => Vault.list().then((l) => l.length === 0).catch(() => true)), "signed out: the files cannot be read");
  await page.reload(); await ready();
  ok(await page.evaluate(() => !Vault.account), "after a reload: still signed out");
  await page.click("#btnSignIn");
  await page.waitForSelector("#authDlg:not([hidden])");
  await page.click("#authGo");
  ok(await waitFn(`Vault.account && Vault.account.name === "Marie Dupont" && document.querySelectorAll('#mpList .mp-item').length === 1`, 20000), "signed in again with the passkey: My PDFs back");

  // a second account on the same browser sees only its own files
  await page.click("#acctBtn"); await page.click("#mSignOut");
  await page.click("#btnSignIn"); await page.click("#authToCreate");
  await page.fill("#authName", "Paul Martin");
  await page.click("#authCreateForm button[type=submit]");
  await waitFn(`Vault.account && Vault.account.name === "Paul Martin"`, 20000);
  ok(await waitFn(`!document.querySelector('#mpEmpty').hidden`), "a second account has its own, empty My PDFs");
  ok(await page.evaluate(async () => { const all = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); }); const files = await new Promise((r) => { const x = all.transaction("files").objectStore("files").getAll(); x.onsuccess = () => r(x.result); }); try { await Vault.load(files[0].id); return false; } catch (e) { return true; } }), "…and cannot open Marie's file");
  // Paul: open a PDF from the computer, then Save adds it to his PDFs
  await page.setInputFiles("#fileInput", pdf);
  await docReady();
  await editLine("NORTHWIND STUDIO", "SOUTHWIND STUDIO");
  await page.click("#btnSave");
  ok(await waitFn(`!S.dirty && ACCOUNT.fileId`), "a PDF opened from the computer: Save adds it to My PDFs");
  await page.click("#acctBtn"); await page.click("#mDelete");
  await page.click("#modalOk");
  ok(await waitFn(`!Vault.account && document.querySelector('#btnSignIn')`, 20000), "Paul deletes his account (passkey confirmed)");
  ok(await page.evaluate(() => Vault.accounts().then((l) => l.length === 1 && l[0].name === "Marie Dupont")), "only Marie's account is left");

  // ---------------------------------------------------------------- rename, delete a file
  await page.click("#btnSignIn"); await page.click("#authGo");
  await waitFn(`Vault.account && Vault.account.name === "Marie Dupont" && document.querySelectorAll('#mpList .mp-item').length === 1`, 20000);
  await page.click("#mpList .mp-more"); await page.click('.mp-menu [data-a="rename"]');
  await page.fill("#modalInput", "Invoice November");
  await page.click("#modalOk");
  ok(await waitFn(`document.querySelector('#mpList .mp-name').textContent === "Invoice November.pdf"`), "rename");
  await page.click("#mpList .mp-more"); await page.click('.mp-menu [data-a="delete"]'); await page.click("#modalOk");
  ok(await waitFn(`document.querySelectorAll('#mpList .mp-item').length === 0`), "delete a file");
  const blobs = await page.evaluate(async () => { const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); }); return new Promise((r) => { const q = d.transaction("blobs").objectStore("blobs").count(); q.onsuccess = () => r(q.result); }); });
  ok(blobs === 0, "its versions are gone from the storage too");

  // ---------------------------------------------------------------- French
  await page.evaluate(() => localStorage.setItem("pdfe.lang", "fr"));
  await page.reload(); await ready();
  ok((await page.textContent("#myPdfs h2")) === "Mes PDF" && (await page.textContent("#mpAdd")) === "Ajouter des PDF", "in French: “Mes PDF”, “Ajouter des PDF”");
  await page.screenshot({ path: `${OUT}/account-fr.png` });
  ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
} catch (e) {
  fails++; console.log("  FAIL exception: " + e.message.split("\n")[0]);
  await page.screenshot({ path: `${OUT}/account-failure.png` }).catch(() => {});
}
await browser.close();
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
