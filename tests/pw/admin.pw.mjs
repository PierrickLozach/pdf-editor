// The admin page used like a person does: open it in a real browser, change a price, untick lifetime,
// click Save; create a free licence with the form; another website cannot post to it.
// Run: node admin.pw.mjs [chromium|firefox|webkit|all] [base url] [admin key]
//      (default: the local server and the key of site/.dev.vars)
import fs from "node:fs";
import http from "node:http";
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all";
const B = (process.argv[3] || "http://localhost:8787").replace(/\/$/, "");
const KEY = process.argv[4] || fs.readFileSync(new URL("../../site/.dev.vars", import.meta.url), "utf8").match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const local = B.startsWith("http://localhost");
let total = 0;
// a page on another site with a form aimed at the admin page
const evil = http.createServer((q, r) => { r.setHeader("Content-Type", "text/html"); r.end(`<form id="f" method="post" action="${B}/api/admin?key=${encodeURIComponent(KEY)}"><input name="key" value="${KEY}"><input name="do" value="shop"><input name="yearly_price" value="1"></form><script>document.getElementById("f").submit()</script>`); }).listen(8797, "127.0.0.1");
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch(); const p = await (await b.newContext()).newPage();
  try {
    await p.goto(`${B}/api/admin?key=${encodeURIComponent(KEY)}`);
    const before = { yearly: await p.inputValue('input[name="yearly_price"]'), lifetime: await p.isChecked('input[name="lifetime"]') };
    // change, Save
    await p.fill('input[name="yearly_price"]', "31");
    await p.uncheck('input[name="lifetime"]');
    await Promise.all([p.waitForNavigation(), p.click('form:has(input[value="shop"]) button.primary')]);
    const body = await p.textContent("body");
    ok(!/Forbidden/.test(body) && /Saved/.test(body), "Save from the page works: " + (body.match(/Saved[^.]*\./) || [body.slice(0, 60)])[0]);
    ok(await p.inputValue('input[name="yearly_price"]') === "31" && !(await p.isChecked('input[name="lifetime"]')), "the new price and the lifetime switch are kept");
    const cfg = await (await fetch(B + "/api/pro/config")).json();
    ok(cfg.plans.some((x) => x.id === "yearly" && x.price === 31) && !cfg.plans.some((x) => x.id === "lifetime"), "the site shows the new settings");
    // a free licence with the form
    await p.fill('input[name="note"]', "admin page test (cancelled)");
    await Promise.all([p.waitForNavigation(), p.click('form:has(input[value="grant"]) button.primary')]);
    const code = ((await p.textContent("body")).match(/PDFE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0];
    ok(!!code, "“Create a code” works: " + code);
    if (code) {   // cancel it at once
      await Promise.all([p.waitForNavigation(), p.click(`tr:has(code:text("${code}")) button[value="revoke"]`)]);
      ok(/Licence cancelled/.test(await p.textContent("body")), "“Cancel” on its line works");
    }
    // put the previous settings back
    await p.fill('input[name="yearly_price"]', before.yearly);
    if (before.lifetime) await p.check('input[name="lifetime"]');
    await Promise.all([p.waitForNavigation(), p.click('form:has(input[value="shop"]) button.primary')]);
    ok(/Saved/.test(await p.textContent("body")), "settings put back as they were");
    // another website submitting the form: refused
    if (local) {
      const e = await (await b.newContext()).newPage();
      await e.goto("http://127.0.0.1:8797/"); await e.waitForLoadState("load").catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      ok(/Forbidden/.test(await e.textContent("body").catch(() => "")), "a form on another website is refused (Forbidden)");
      const c2 = await (await fetch(B + "/api/pro/config")).json();
      ok(!c2.plans.some((x) => x.id === "yearly" && x.price === 1), "…and changed nothing");
    }
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
  await b.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  total += fails;
}
evil.close();
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
