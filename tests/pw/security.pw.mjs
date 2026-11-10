// Security checks, organised by OWASP Top 10:2025, against the local site or the live one.
// Chromium.
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
const waitFn = async (expr, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(100); } return false; };
const ready = () => waitFn(`document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait') && document.querySelector('#sizeNote')`, 60000);
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
  /* -------------------------------------------------------------- A05: file names */
  await page.evaluate(() => { S.dirty = false; });
  await page.setInputFiles("#fileInput", { name: "<svg onload=window.__xss=3>.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(fx("demo-invoice.pdf")) });
  await waitFn(`S.doc && /svg/.test(S.doc.name) && pageEl(0).dataset.rkey`);
  ok(await page.evaluate(() => window.__xss === undefined && !document.querySelector("svg[onload]") && /<svg/.test(document.querySelector("#docName").textContent) && /<svg/.test(document.title)), "a file name containing HTML is shown as text (toolbar, window title)");

  /* -------------------------------------------------------------- A01 / A04: no account, no stored documents */
  section("A01 Access control / A04 Cryptography – nothing to steal on the server, little in the browser");
  ok(await page.evaluate(() => !window.Vault && !document.querySelector("#btnSignIn, #acctArea, #myPdfs")), "no accounts: no sign-in to attack, no stored document collections");
  const dbs = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
  ok(!dbs.includes("pdf-editor-vault"), "no old account storage left in a fresh browser: " + dbs.join(", "));
  await sleep(1500);
  const cur = await idb("pdf-editor", "docs", "get", "current");
  ok(!cur || (cur.name && cur.bytes), "the only document kept is the crash-recovery copy of the open PDF (removed by “Close”)");
  await page.click("#btnClose");
  await waitFn(`!S.doc`);
  ok(!(await idb("pdf-editor", "docs", "get", "current")), "“Close” erases it");

  /* -------------------------------------------------------------- A06 / A10: limits and errors */
  section("A06 Insecure design / A10 Exceptional conditions – limits and errors");
  ok(/250 MB/.test(await page.textContent("#sizeNote")), "the start screen shows the size limit: " + (await page.textContent("#sizeNote")));
  await page.evaluate(() => { FILES.maxBytes = 1024 * 1024; });
  await page.setInputFiles("#fileInput", fx("photo.pdf"));
  ok(await waitFn(`!document.querySelector('#modal').hidden && /too large/.test(document.querySelector('#modalTitle').textContent)`), "a PDF over the limit is refused before it is read, with an explanation");
  await page.click("#modalOk");
  await page.evaluate(() => { FILES.maxBytes = 250 * 1024 * 1024; });
  await page.setInputFiles("#fileInput", { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF") });
  ok(await waitFn(`document.querySelector('#toast').classList.contains('error') || (S.doc && S.doc.name === "broken.pdf")`, 15000), "a damaged PDF gives a message, not a crash: " + (await page.textContent("#toast")).slice(0, 80));
  await page.setInputFiles("#fileInput", { name: "not-a-pdf.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html><script>window.__xss=4</script></html>") });
  ok(await waitFn(`document.querySelector('#toast').classList.contains('error')`, 15000) && await page.evaluate(() => window.__xss === undefined), "an HTML file renamed .pdf is refused and never run");


  /* -------------------------------------------------------------- active content and hostile files */
  section("A08 Integrity / A05 Injection – active content in PDFs");
  await page.evaluate(() => { S.dirty = false; });
  await page.setInputFiles("#fileInput", fx("hostile.pdf"));
  await docReady();
  ok(await waitFn(`!document.querySelector('#activeBar').hidden`), "a PDF with scripts, a launch action, a javascript: link, an attachment and XFA: a notice appears");
  ok(/scripts/.test(await page.textContent("#activeBar")) && /program launch/.test(await page.textContent("#activeBar")), "…naming them: " + (await page.textContent("#activeBar .ab-text")).slice(0, 110));
  ok(await page.evaluate(() => window.__xss === undefined && !document.querySelector("iframe, embed, object")), "nothing in it is run or embedded by the editor");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
  const saved = fs.readFileSync(await dl.path()).toString("latin1");
  ok(!/\/JavaScript|\/JS\b|\/Launch|javascript:|\/XFA|EmbeddedFile|payload\.exe|\/OpenAction/.test(saved), "the saved PDF has none of it left");
  ok(await page.evaluate(() => call("find", "Hostile test PDF").then((h) => h.length === 1)), "the text is still real text");
  await page.evaluate(() => { S.dirty = false; });
  await page.setInputFiles("#fileInput", fx("hostile.pdf"));
  await docReady();
  await waitFn(`!document.querySelector('#activeBar').hidden`);
  await page.click("#activeBar .ab-keep");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
  ok(/\/Launch/.test(fs.readFileSync(await dl2.path()).toString("latin1")), "“Keep it”: the person can choose to keep it (their decision)");

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
