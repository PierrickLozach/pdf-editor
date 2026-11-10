// Security checks, organised by OWASP Top 10:2025, against the local site or the live one.
// Chromium with a virtual passkey authenticator (NOPRF=1: a passkey without the PRF feature).
// Run: node security.pw.mjs [base-url]      (default http://localhost:8787)
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const fx = (n) => new URL(`../fixtures/${n}`, import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const section = (s) => console.log(`\n${s}`);

/* ---------------------------------------------------------------- A02 configuration: headers */
section("A02 Security misconfiguration – headers on every kind of response");
for (const p of ["/", "/fr/privacy", "/app/", "/app/vendor/mupdf/mupdf.js", "/assets/site.js", "/no-such-page", "/.well-known/security.txt"]) {
  const r = await fetch(BASE + p, { redirect: "manual" });
  const h = (k) => r.headers.get(k) || "";
  const csp = h("content-security-policy");
  const script = (csp.match(/script-src([^;]*)/) || [])[1] || "";
  const style = (csp.match(/style-src([^;]*)/) || [])[1] || "";
  const good = csp && !/unsafe-inline|'unsafe-eval'|\*/.test(script.replace("'wasm-unsafe-eval'", "")) && !/unsafe-inline/.test(style) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp)
    && h("x-content-type-options") === "nosniff" && h("x-frame-options") === "DENY" && /max-age=\d{8}/.test(h("strict-transport-security"))
    && h("cross-origin-opener-policy") === "same-origin" && h("cross-origin-resource-policy") === "same-origin" && /camera=\(\)/.test(h("permissions-policy"));
  ok(good, `${p} (${r.status}): strict CSP, no inline scripts or styles, no framing, HSTS, nosniff, COOP/CORP` + (/wasm-unsafe-eval/.test(script) ? " (WebAssembly allowed for the PDF engine, nothing else)" : ""));
}
{
  const r = await fetch(BASE + "/app/");
  const csp = r.headers.get("content-security-policy");
  ok(/connect-src 'self' https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/;/.test(csp), "editor: network limited to this site and the font library folder");
  const t = await (await fetch(BASE + "/.well-known/security.txt")).text();
  ok(/^Contact: https:\/\//m.test(t) && /^Expires: 20\d\d-/m.test(t), "security.txt: how to report a vulnerability (RFC 9116)");
  const listing = await fetch(BASE + "/app/vendor/");
  ok(listing.status === 404 || !(await listing.text()).includes("mupdf-wasm.wasm"), "no directory listing");
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [], violations = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/downloadable font|status of 404|Refused to connect|Content Security Policy/.test(m.text())) errs.push(m.text()); });
await ctx.exposeFunction("__cspViolation", (v) => violations.push(v));
await ctx.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`));
  localStorage.setItem("pdfe.fontIntroSeen", "1");
});
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: !process.env.NOPRF, automaticPresenceSimulation: true } });
const waitFn = async (expr, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(100); } return false; };
const ready = () => waitFn(`document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait') && document.querySelector('#acctArea')`, 60000);
const docReady = () => waitFn(`S.doc && S.spans[S.doc.pages[0].v] && pageEl(0).dataset.rkey && !S.pending`);
const idb = (db, store, op = "getAll", key) => page.evaluate(async ([db, store, op, key]) => {
  const d = await new Promise((r, j) => { const q = indexedDB.open(db); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  if (!d.objectStoreNames.contains(store)) return null;
  return new Promise((r) => { const q = d.transaction(store).objectStore(store)[op](key); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
}, [db, store, op, key]);

try {
  await page.goto(BASE + "/app/");
  await ready();

  /* -------------------------------------------------------------- A05 injection */
  section("A05 Injection – HTML in PDFs, names and file names is shown as text, never run");
  await page.setInputFiles("#fileInput", fx("evil-font-name.pdf"));
  await docReady();
  const sp = await page.evaluate(() => { const s = S.spans[S.doc.pages[0].v][0]; const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 4) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom, font: s.font, shown: s.family }; });
  ok(/<img/.test(sp.font), "the test PDF names its font with HTML: " + sp.font + "  (shown as: " + sp.shown + ")");
  await page.mouse.click(sp.x, sp.y);
  await waitFn(`S.ed && document.querySelector('#editorBar') && !document.querySelector('#editorBar').hidden`);
  await sleep(300);
  ok(await page.evaluate(() => !document.querySelector("#edInfo img") && window.__xss === undefined && document.querySelector("#edInfo").textContent.length > 5), "a malicious font name is not run in the editor bar: " + (await page.textContent("#edInfo")).slice(0, 60));
  await page.keyboard.press("Escape");
  ok(await page.evaluate(() => window.__xss === undefined && !document.querySelector("img[src='x']")), "no injected element anywhere on the page");

  /* -------------------------------------------------------------- A07 authentication, A01 access */
  section("A07 Authentication / A01 Access control – passkey accounts");
  await page.click("#btnClose");
  await waitFn(`!S.doc`);
  await page.click("#hintCreate");
  await page.fill("#authName", "<img src=x onerror=window.__xss=2>");
  await page.click("#authCreateForm button[type=submit]");
  ok(await waitFn(`Vault.account`, 20000), "account created (mode: " + (await page.evaluate(() => Vault.account && Vault.account.mode)) + ")");
  await page.click("#acctBtn");
  ok(await page.evaluate(() => !document.querySelector("#acctMenu img") && window.__xss === undefined && /<img/.test(document.querySelector("#acctMenu .who b").textContent)), "a name containing HTML is shown as text");
  await page.keyboard.press("Escape"); await page.mouse.click(5, 500);
  await page.setInputFiles("#mpInput", { name: "<svg onload=window.__xss=3>.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(fx("demo-invoice.pdf")) });
  ok(await waitFn(`document.querySelectorAll('#mpList .mp-item').length === 1`), "a PDF whose name contains HTML is added");
  ok(await page.evaluate(() => !document.querySelector("#mpList svg[onload], #mpList svg:not(.mp-open svg)") && window.__xss === undefined), "its name is shown as text");

  /* -------------------------------------------------------------- A04 cryptography */
  section("A04 Cryptographic failures – keys and stored data");
  const sid = await page.evaluate(() => sessionStorage.getItem("pdfe.vaultSession"));
  ok(/^[A-Za-z0-9_-]{20,24}$/.test(sid || ""), "the tab keeps only a random sign-in id, no key material");
  const keyInfo = await page.evaluate(async (sid) => {
    const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); });
    const s = await new Promise((r) => { const q = d.transaction("sessions").objectStore("sessions").get(sid); q.onsuccess = () => r(q.result); });
    let exported = "refused";
    try { await crypto.subtle.exportKey("raw", s.key); exported = "EXPORTED"; } catch (e) {}
    const accts = await new Promise((r) => { const q = d.transaction("accounts").objectStore("accounts").getAll(); q.onsuccess = () => r(q.result); });
    const devKeys = accts.filter((a) => a.deviceKey).map((a) => a.deviceKey.extractable);
    return { algo: s.key.algorithm.name + "-" + s.key.algorithm.length, extractable: s.key.extractable, exported, devKeys };
  }, sid);
  ok(keyInfo.algo === "AES-GCM-256" && keyInfo.extractable === false && keyInfo.exported === "refused" && keyInfo.devKeys.every((x) => x === false), `encryption key AES-GCM-256, not extractable: even a script on the page cannot read it (${JSON.stringify(keyInfo)})`);
  await page.click("#mpList .mp-open");
  await docReady();
  const line = await page.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === "14 Harbour Street"); const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 4) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
  await page.mouse.click(line.x, line.y);
  await waitFn(`S.ed && document.activeElement === S.ed.box`);
  await page.evaluate(() => document.getSelection().selectAllChildren(S.ed.box));
  await page.keyboard.insertText("Secret Road 1");
  await page.keyboard.press("Enter");
  await waitFn(`!S.ed && !S.pending`);
  await sleep(1500);                                   // the crash-recovery copy is written ~1 s after a change
  const current = await idb("pdf-editor", "docs", "get", "current");
  ok(!current, "while signed in, no unencrypted copy of the open PDF is written to the browser");
  await page.click("#btnSave");
  await waitFn(`!S.dirty`);
  const raw = await page.evaluate(async () => {
    const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); });
    const all = await new Promise((r) => { const q = d.transaction("blobs").objectStore("blobs").getAll(); q.onsuccess = () => r(q.result); });
    const dec = new TextDecoder("latin1");
    return all.map((b) => dec.decode(new Uint8Array(b))).join("");
  });
  ok(!raw.includes("%PDF") && !raw.includes("Secret Road") && !raw.includes("Harbour"), "stored PDFs contain no readable text");

  /* -------------------------------------------------------------- A08 integrity */
  section("A08 Integrity – tampered data is refused");
  const tampered = await page.evaluate(async () => {
    const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); });
    const files = await new Promise((r) => { const q = d.transaction("files").objectStore("files").getAll(); q.onsuccess = () => r(q.result); });
    const v = files[0].versions[0];
    const blob = await new Promise((r) => { const q = d.transaction("blobs").objectStore("blobs").get(v.blob); q.onsuccess = () => r(q.result); });
    const b = new Uint8Array(blob).slice(); b[100] ^= 1;                   // one bit changed
    await new Promise((r) => { const x = d.transaction("blobs", "readwrite"); x.objectStore("blobs").put(b, v.blob); x.oncomplete = r; });
    try { await Vault.load(files[0].id); return "OPENED"; } catch (e) { return e.message; }
  });
  ok(/changed or damaged/.test(tampered), "a changed bit in a stored PDF is detected: " + tampered);

  /* -------------------------------------------------------------- A07 sessions */
  section("A07 Authentication – sign-in lifetime");
  await page.evaluate(() => { S.dirty = false; });
  await page.evaluate(async (sid) => {
    const d = await new Promise((r) => { const q = indexedDB.open("pdf-editor-vault"); q.onsuccess = () => r(q.result); });
    const st = d.transaction("sessions", "readwrite").objectStore("sessions");
    const s = await new Promise((r) => { const q = st.get(sid); q.onsuccess = () => r(q.result); });
    await new Promise((r) => { const x = d.transaction("sessions", "readwrite"); x.objectStore("sessions").put({ ...s, lastActive: Date.now() - 31 * 60000 }); x.oncomplete = r; });
    document.dispatchEvent(new Event("visibilitychange"));
  }, sid);
  ok(await waitFn(`!Vault.account && /30 minutes/.test(document.querySelector('#toast').textContent)`, 10000), "after 30 minutes without activity: signed out, with a message");
  ok(!(await idb("pdf-editor-vault", "sessions", "get", sid)), "the expired sign-in is erased");
  await page.reload(); await ready();
  ok(await page.evaluate(() => !Vault.account), "a reload does not bring it back");
  await page.click("#btnSignIn"); await page.click("#authGo");
  ok(await waitFn(`Vault.account`, 20000), "signing in again with the passkey works");
  ok(await page.evaluate(() => !!(Vault.account.previousSignIn)), "the account menu shows the previous sign-in (to spot one you did not make)");
  const forged = await page.evaluate(async () => {
    if (Vault.account.mode !== "device") return "prf";
    Vault.signOut();
    const real = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (o) => { const c = await real(o); const sig = new Uint8Array(c.response.signature); sig[sig.length - 3] ^= 0x55;
      return { id: c.id, rawId: c.rawId, getClientExtensionResults: () => ({}), response: { userHandle: c.response.userHandle, clientDataJSON: c.response.clientDataJSON, authenticatorData: c.response.authenticatorData, signature: sig.buffer } }; };
    try { await Vault.signIn(); return "SIGNED IN"; } catch (e) { return e.message; } finally { navigator.credentials.get = real; }
  });
  ok(forged === "prf" || /could not be verified/.test(forged), forged === "prf" ? "forged sign-in: impossible by design with PRF passkeys (the key comes from the passkey)" : "a forged passkey answer is refused");
  if (!(await page.evaluate(() => !!Vault.account))) { await page.click("#btnSignIn"); await page.click("#authGo"); await waitFn(`Vault.account`, 20000); }

  /* -------------------------------------------------------------- A06 design, A10 exceptional conditions */
  section("A06 Insecure design / A10 Exceptional conditions – limits and errors");
  ok(/200 MB/.test(await page.textContent("#myPdfs .mp-note")), "My PDFs shows the limit: “Up to 200 MB per PDF”");
  await page.click("#mpSizeHelp");
  ok(/200 MB/.test(await page.textContent("#modalText")) && /Reduce file size/.test(await page.textContent("#modalText")), "“Too large?” explains the limit and how to reduce a PDF");
  await page.click("#modalOk");
  await page.evaluate(() => { Vault.maxFileBytes = 1024 * 1024; });                  // simulate a small limit: 1 MB
  await page.setInputFiles("#mpInput", fx("photo.pdf"));                              // 4.6 MB of photo
  ok(await waitFn(`!document.querySelector('#modal').hidden && /too large/i.test(document.querySelector('#modalTitle').textContent)`), "a PDF over the limit: clear explanation, with its size and the limit");
  ok(/4\.\d MB/.test(await page.textContent("#modalText")) && /1 MB/.test(await page.textContent("#modalText")), "…" + (await page.textContent("#modalText")).slice(0, 90));
  await page.click("#modalOk");                                                       // "Reduce its size"
  await waitFn(`!document.querySelector('#reduceDlg').hidden && /Current size/.test(document.querySelector('.rd-now').textContent)`);
  await page.check('input[name="rdLevel"][value="smallest"]');
  await page.click("#reduceDlg .rd-go");
  ok(await waitFn(`!document.querySelector('#modal').hidden && /Save it in My PDFs/.test(document.querySelector('#modalTitle').textContent)`, 60000), "reduced under the limit, then offered to save");
  await page.click("#modalOk");
  ok(await waitFn(`!S.dirty && ACCOUNT.fileId`), "saved in My PDFs");
  await page.evaluate(() => { Vault.maxFileBytes = 200 * 1024 * 1024; });
  const sizes = await page.evaluate(async () => (await Vault.list()).map((f) => f.size));
  ok(sizes.some((s) => s < 1024 * 1024), "the stored copy is under the limit: " + sizes.map((s) => (s / 1048576).toFixed(2) + " MB").join(", "));
  ok(await page.evaluate(() => call("find", "Holiday photo report").then((h) => h.length === 1)), "after reducing, the text is still real text");
  await page.click("#btnReduce");
  await waitFn(`!document.querySelector('#reduceDlg').hidden && /Current size: \\d/.test(document.querySelector('.rd-now').textContent)`);
  ok(/Current size: .* · My PDFs accept up to 200 MB/.test(await page.textContent(".rd-now")), "“Reduce file size…” in the page panel shows the size and the limit");
  await page.click("#reduceDlg .rd-cancel");
  const tooBig = await page.evaluate(async () => { try { await Vault.save(new Uint8Array(Vault.maxFileBytes + 1), "x.pdf"); return "SAVED"; } catch (e) { return e.message; } });
  ok(/too large/.test(tooBig), "the storage layer refuses oversized files itself: " + tooBig);

  /* -------------------------------------------------------------- A03 supply chain */
  section("A03 Software supply chain – third-party content");
  const net = await page.evaluate(async () => { try { await fetch("https://example.com/"); return "ALLOWED"; } catch (e) { return "blocked"; } });
  ok(net === "blocked", "the page cannot send data to other sites (the browser blocks it)");
  const cat = await (await fetch(BASE + "/app/fonts/free-fonts.json")).json();
  const pinned = Object.values(cat).every((v) => /^\d+\.\d+\.\d+$/.test(v[5]));
  ok(pinned, `all ${Object.keys(cat).length} free fonts are pinned to an exact version (published versions never change)`);

  const unexpected = violations.filter((v) => !/example\.com/.test(v));          // the probe above is blocked on purpose
  ok(unexpected.length === 0, "no Content-Security-Policy violation during the whole run (besides the deliberate probe) " + unexpected.slice(0, 3).join(" | "));
  ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
} catch (e) {
  fails++; console.log("  FAIL exception: " + e.message.split("\n")[0]);
  await page.screenshot({ path: "/tmp/pdfe-site/security-failure.png" , caret: "initial" }).catch(() => {});
}
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL OK");
process.exit(fails ? 1 : 0);
