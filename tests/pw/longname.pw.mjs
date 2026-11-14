// A long file name: the "Saved / Not saved" note after it is always shown in full; the name is cut instead
// (ellipsis, full name in its tooltip), at every window width and in long languages; the toolbar stays on one line.
// Run: node longname.pw.mjs [chromium|firefox|webkit|all] [url]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", URL0 = process.argv[3] || "http://localhost:8787/app/";
const long = path.join(os.tmpdir(), "jane.doe@example.com_Northwind Studio – Quarterly invoice and payment schedule for 2026 (final version).pdf");
fs.copyFileSync(new URL("../fixtures/demo-invoice.pdf", import.meta.url), long);
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch();
  for (const lang of ["en-US", "de-DE"]) {
    const c = await b.newContext({ viewport: { width: 1600, height: 900 }, locale: lang });
    await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
    await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
    const p = await c.newPage();
    try {
      await p.goto(URL0); await p.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
      await p.setInputFiles("#fileInput", long); await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey);
      await p.evaluate(async () => { const sp = await call("pageText", 0), t = sp.find((x) => x.text.trim() === "Blue Harbor Consulting"); applyInfo(await call("editSpan", 0, t.id, t.text, "Blue Lake Consulting")); });
      for (const w of [1600, 1280, 1100, 900, 780]) {
        await p.setViewportSize({ width: w, height: 800 }); await new Promise((r) => setTimeout(r, 350));
        const r = await p.evaluate(() => { const n = document.querySelector("#saveState"), d = document.querySelector("#docName"), tb = document.querySelector("#toolbar");
          const nr = n.getBoundingClientRect(), br = document.querySelector(".brand").getBoundingClientRect();
          return { note: n.textContent, full: n.scrollWidth <= n.clientWidth + 1, shown: !n.hidden && getComputedStyle(n).display !== "none" && nr.width > 0, inside: nr.right <= br.right + 1,
                   cut: d.scrollWidth > d.clientWidth, nameW: Math.round(d.getBoundingClientRect().width), title: d.title, fits: tb.scrollWidth <= tb.clientWidth + 1 }; });
        ok(r.shown && r.full && r.inside && r.note.length > 3 && r.fits, `${lang} ${w}px: note shown in full (“${r.note}”), name cut to ${r.nameW}px, toolbar on one line` + JSON.stringify({ shown: r.shown, full: r.full, inside: r.inside, fits: r.fits }));
        if (w >= 1100) ok(r.nameW >= 20, `${lang} ${w}px: some of the name is shown (${r.nameW}px)`);
        if (w === 1100) ok(r.cut && /final version/.test(r.title), `${lang}: the long name is cut with “…”, the full name is in its tooltip`);
      }
    } catch (x) { fails++; console.log(`  FAIL [${name}] ${lang} exception: ${x.message.split("\n")[0]}`); }
    await c.close();
  }
  await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
}
fs.rmSync(long, { force: true });
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
