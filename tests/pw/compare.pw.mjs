// Compare two PDFs, word by word, in a real browser: a deleted word and a replaced word are named in
// the panel (crossed out / marked) and marked at their place on the page; clicking a line shows it.
// Run: node compare.pw.mjs [chromium|firefox|webkit|all] [url]
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", URL0 = process.argv[3] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname, b64 = fs.readFileSync(pdf).toString("base64");
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch(); const c = await b.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
  await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
  const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  try {
    await p.goto(URL0); await p.waitForFunction(() => document.body.classList.contains("engine-ready") && window.PRO, null, { timeout: 60000 });
    await p.setInputFiles("#fileInput", pdf); await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey);
    await p.evaluate(async (b64) => {
      PRO.require = async () => true;                     // the Pro check itself is tested in pro.pw.mjs
      const sp = await call("pageText", 0);
      const a = sp.find((x) => /Website design/.test(x.text)); applyInfo(await call("editSpan", 0, a.id, a.text, "Website 6 pages"));      // one word deleted
      const t = sp.find((x) => x.text.trim() === "Blue Harbor Consulting"); applyInfo(await call("editSpan", 0, t.id, t.text, "Blue Lake Consulting"));   // one word replaced
      await PROTOOLS.compare(new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], "original.pdf", { type: "application/pdf" }));
    }, b64);
    await p.waitForSelector("#cmpPanel"); await p.waitForFunction(() => document.querySelectorAll("#pages .cmp-del").length >= 2, null, { timeout: 10000 }).catch(() => {});
    const r = await p.evaluate(() => ({ del: [...document.querySelectorAll("#cmpPanel .cmp-item del")].map((x) => x.textContent), ins: [...document.querySelectorAll("#cmpPanel .cmp-item ins")].map((x) => x.textContent),
      items: document.querySelectorAll("#cmpPanel .cmp-item").length, marks: document.querySelectorAll("#pages .cmp-del").length, hl: document.querySelectorAll("#pages .cmp-hl").length,
      markTitles: [...document.querySelectorAll("#pages .cmp-del")].map((x) => x.title) }));
    ok(r.items === 2, "panel: 2 changed lines (no “no longer here” for a deleted word)");
    ok(r.del.includes("design,") && r.del.includes("Harbor"), "panel: the removed words are named, crossed out: " + r.del.join(", "));
    ok(r.ins.length === 1 && r.ins[0] === "Lake", "panel: the new word is marked: " + r.ins.join(", "));
    ok(r.marks === 2 && r.markTitles.some((x) => /design,/.test(x)), "page: a red mark where each word was removed: " + r.markTitles.join(" | "));
    ok(r.hl === 1, "page: only the new word is highlighted");
    await p.click("#cmpPanel .cmp-go");
    ok(await p.waitForFunction(() => document.querySelector("#pages .cmp-line.flash"), null, { timeout: 5000 }).then(() => true, () => false), "clicking a line in the panel shows it on the page");
    await p.click("#cmpPanel .cmp-x");
    ok(await p.evaluate(() => !document.querySelector("#cmpPanel") && !document.querySelector("#pages .cmp-del, #pages .cmp-hl")), "closing the comparison removes the marks");
    ok(!errs.length, "no script errors " + errs.slice(0, 2).join(" | "));
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
  await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
}
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
