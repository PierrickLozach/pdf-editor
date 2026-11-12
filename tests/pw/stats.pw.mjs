// Anonymous visit statistics: the pages and the editor send counts to /api/hit, never in automated
// browsers (tests), never with Do Not Track / Global Privacy Control or after "Do not count my visits";
// nothing personal is sent (no file name, no document text). The stats page needs the key.
// Run: node stats.pw.mjs [base url] [stats key]
import fs from "node:fs";
import { chromium } from "playwright";
const B = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.argv[3] || fs.readFileSync("/tmp/stats-key.txt", "utf8").trim();
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const run = async (opts, fn, testMode = true) => {
  const c = await b.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  if (testMode) await c.addInitScript(() => { window.PDFE_STATS_TEST = true; localStorage.setItem("pdfe.fontIntroSeen", "1"); });
  const sent = [];
  // read what the page sends (beacons included) and answer like the server, without storing anything
  await c.route("**/api/hit", async (route) => {
    try { sent.push(JSON.parse(route.request().postData() || "{}")); } catch (e) { sent.push({ bad: true }); }
    await route.fulfill({ status: 204, body: "" });
  });
  const p = await c.newPage();
  await fn(p, sent);
  await c.close();
  return sent;
};
// 1. a visit: landing page, then the editor, open a PDF, use a tool
let sent = await run({ locale: "fr-FR" }, async (p) => {
  await p.goto(B + "/fr/"); await sleep(500);
  await p.goto(B + "/app/");
  await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
  await p.setInputFiles("#fileInput", new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname);
  await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey);
  await p.evaluate(() => { TOOLS.run("numbers"); });                 // opens the tool's window (not awaited)
  await p.waitForSelector("#numbersDlg"); await p.click("#numbersDlg .td-cancel");
  await sleep(800);
});
const pages = sent.filter((x) => x.t === "page"), evs = sent.filter((x) => x.t === "event");
ok(pages.length === 2 && pages[0].p === "/fr/" && pages[0].v === 1 && pages[1].p === "/app/" && pages[1].v === 0, "a visit: first page counted as the visit, the next one as a page: " + pages.map((x) => x.p + (x.v ? "*" : "")).join(", "));
ok(evs.some((x) => x.e === "pdf_opened" && x.x === "<1MB") && evs.some((x) => x.e === "tool_used" && x.x === "numbers"), "editor: “PDF opened” (size range) and “tool used” counted: " + evs.map((x) => x.e + ":" + x.x).join(", "));
const all = JSON.stringify(sent);
ok(!/demo-invoice|NORTHWIND|Harbour|invoice/i.test(all), "nothing about the document is sent (no file name, no text)");
ok(sent.every((x) => Object.keys(x).every((k) => ["t", "p", "v", "r", "u", "l", "e", "x"].includes(k))), "only the documented fields are sent");
// 2. automated browsers (tests, bots) are never counted
sent = await run({}, async (p) => { await p.goto(B + "/"); await sleep(800); }, false);
ok(sent.length === 0, "an automated browser (test, bot) sends nothing");
// 3. Do Not Track / Global Privacy Control
sent = await run({}, async (p) => { await p.addInitScript(() => Object.defineProperty(navigator, "globalPrivacyControl", { get: () => true })); await p.goto(B + "/"); await sleep(800); });
ok(sent.length === 0, "Global Privacy Control: nothing sent");
// 4. the opt-out switch on the privacy page
sent = await run({ locale: "en-US" }, async (p) => {
  await p.goto(B + "/privacy"); await sleep(300);
  ok(await p.isVisible("#statsOptOut") && !(await p.isChecked("#statsOptOut")), "privacy page: “Do not count my visits in this browser” switch, off by default");
  await p.check("#statsOptOut");
  await p.goto(B + "/"); await p.goto(B + "/app/"); await sleep(800);
});
ok(sent.length === 1, "after opting out, nothing more is sent (only the privacy page itself had been counted): " + sent.length);
// 5. the statistics page
const r1 = await fetch(B + "/api/stats"), r2 = await fetch(B + "/api/stats?key=" + "x".repeat(KEY.length)), r3 = await fetch(B + "/api/stats?key=" + encodeURIComponent(KEY));
ok(r1.status === 404 && r2.status === 404 && r3.status === 200, `stats page: 404 without the key or with a wrong one, 200 with it (${r1.status}/${r2.status}/${r3.status})`);
const h = await r3.text();
ok(/visits/.test(h) && /noindex/.test(r3.headers.get("x-robots-tag") || ""), "the stats page shows the figures and is hidden from search engines");
await b.close();
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
