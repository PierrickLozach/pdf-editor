// Start screen: ONE "Recent files" list. A PDF with unsaved changes (tab closed, browser quit) appears once,
// on its own file's line, marked "Unsaved changes", with Resume (Save then goes back into the file) and
// Discard; at most 5 files are listed. No separate "Resume editing" box any more.
// Run: node recent.pw.mjs [url]
import fs from "node:fs";
import { chromium, firefox } from "playwright";
const URL0 = process.argv[2] || "http://localhost:8787/app/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = fs.readFileSync(new URL("../fixtures/demo-invoice.pdf", import.meta.url)).toString("base64");
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
const waitFn = async (expr, t = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); } return false; };
const ready = () => waitFn(`document.body.classList.contains('engine-ready') && !document.documentElement.classList.contains('i18n-wait')`, 60000);
const rows = () => page.evaluate(() => [...document.querySelectorAll("#recentFiles li")].map((li) => ({ name: li.querySelector(".rf-name").textContent, unsaved: !!li.querySelector(".rf-badge"), when: li.querySelector(".rf-when").textContent })));
try {
  await page.goto(URL0); await ready();
  // 7 PDFs in the private file system, opened one after the other (so 7 recent files)
  await page.evaluate(async (b64) => {
    const root = await navigator.storage.getDirectory(), bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    window.__h = [];
    for (let k = 1; k <= 7; k++) { const h = await root.getFileHandle(`file-${k}.pdf`, { create: true }); const w = await h.createWritable(); await w.write(u); await w.close(); window.__h.push(h); }
  }, b64);
  for (let k = 0; k < 7; k++) {
    await page.evaluate((k) => { window.showOpenFilePicker = async () => [window.__h[k]]; S.dirty = false; }, k);
    await page.click("#btnOpen");
    await waitFn(`S.doc && S.doc.name === "file-${k + 1}.pdf" && pageEl(0).dataset.rkey`);
    await sleep(150);
  }
  // edit the last one, then "close the tab" (reload without saving)
  await page.evaluate(async () => { const sp = (await call("pageText", 0)).find((s) => s.text.trim() === "NORTHWIND STUDIO"); applyInfo(await call("editSpan", 0, sp.id, sp.text, "SOUTHWIND STUDIO")); });
  await sleep(2500);                                                     // the crash-recovery copy is written
  await page.reload(); await ready();
  await waitFn(`document.querySelectorAll('#recentFiles li').length`);
  await sleep(300);
  let r = await rows();
  ok(r.length === 5, `at most 5 files listed (${r.length}): ` + r.map((x) => x.name + (x.unsaved ? " [unsaved]" : "")).join(", "));
  ok(r[0].name === "file-7.pdf" && r[0].unsaved && r.filter((x) => x.name === "file-7.pdf").length === 1, "the file with unsaved changes is listed once, first, marked “Unsaved changes”");
  ok(await page.evaluate(() => { const b = document.getElementById("resume"); return !b || b.hidden; }), "no separate “Resume editing” box");
  ok(r.every((x) => x.when && x.when.length <= 12), "short dates: " + r.map((x) => x.when).join(" · "));
  // Resume: the edit is back and Save goes into file-7.pdf
  await page.click("#recentFiles li:first-child .rf-open");
  ok(await waitFn(`S.doc && S.dirty && pageEl(0).dataset.rkey`) && await page.evaluate(() => call("find", "SOUTHWIND STUDIO").then((h) => h.length === 1)), "Resume: the unsaved edit is back");
  await page.click("#btnSave");
  await waitFn(`!document.querySelector('#saveDlg').hidden`);
  ok(/file-7\.pdf/.test(await page.textContent("#saveDlg .sd-replace")), "Save offers to replace file-7.pdf itself: " + (await page.textContent("#saveDlg .sd-replace")));
  await page.click("#saveDlg .sd-replace");
  await waitFn(`!S.dirty`);
  const saved = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const f = await (await root.getFileHandle("file-7.pdf")).getFile(); return f.size; });
  ok(saved > 1000, "saved into file-7.pdf");
  await page.reload(); await ready(); await waitFn(`document.querySelectorAll('#recentFiles li').length`); await sleep(400);
  ok(!(await page.evaluate(() => !!document.querySelector("#recentFiles .rf-badge"))), "after saving, a reload shows no “Unsaved changes” mark");
  await page.click("#recentFiles li:first-child .rf-open");
  await waitFn(`S.doc && pageEl(0).dataset.rkey`);
  // Discard: edit again, reload, discard
  await page.evaluate(async () => { const sp = (await call("pageText", 0)).find((s) => s.text.trim() === "INVOICE"); applyInfo(await call("editSpan", 0, sp.id, sp.text, "RECEIPT")); });
  await sleep(2500);
  await page.reload(); await ready(); await waitFn(`document.querySelector('#recentFiles .rf-badge')`);
  await page.click("#recentFiles li:first-child .rf-del");
  await page.waitForSelector("#modal:not([hidden])"); await page.click("#modalOk");
  ok(await waitFn(`!document.querySelector('#recentFiles .rf-badge')`), "Discard: the unsaved changes go, the file stays in the list");
  r = await rows();
  ok(r[0].name === "file-7.pdf" && !r[0].unsaved && r.length === 5, "…file-7.pdf is still listed, without the mark");
  await page.reload(); await ready(); await sleep(500);
  ok(!(await page.evaluate(() => !!document.querySelector("#recentFiles .rf-badge"))), "…and the mark does not come back");
  ok(errs.length === 0, "no script errors " + errs.slice(0, 2).join(" | "));
} catch (e) { fails++; console.log("  FAIL exception: " + e.message.split("\n")[0]); await page.screenshot({ path: "/tmp/pdfe-site/recent-failure.png" }).catch(() => {}); }
await browser.close();
// Firefox: no recent files there, but an unsaved copy still gets one line in the list
{
  const fb = await firefox.launch(); const c = await fb.newContext(); const p = await c.newPage();
  await c.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
  await p.goto(URL0); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
  await p.setInputFiles("#fileInput", new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname);
  await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey);
  await p.evaluate(async () => { const sp = (await call("pageText", 0)).find((s) => s.text.trim() === "INVOICE"); applyInfo(await call("editSpan", 0, sp.id, sp.text, "RECEIPT")); });
  await sleep(2500); await p.reload(); await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 }); await sleep(800);
  const r = await p.evaluate(() => [...document.querySelectorAll("#recentFiles li")].map((li) => li.textContent));
  ok(r.length === 1 && /demo-invoice\.pdf/.test(r[0]) && /Unsaved changes/.test(r[0]), "Firefox: the unsaved PDF is one line of “Recent files”: " + r.join(" | "));
  await fb.close();
}
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
