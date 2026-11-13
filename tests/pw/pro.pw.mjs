// Pro in a real browser, against the local server and a fake Lemon Squeezy (mock-ls.mjs, started by
// the server's LS_API setting): the Pro window, free licences from the admin page, one computer at a
// time, release, a Lemon Squeezy key, a forged licence refused, the 5 Pro features, prices and the
// lifetime switch from the admin page, the shop that cannot open without business details.
// Run: node pro.pw.mjs [chromium|firefox|webkit|all]     (needs: wrangler dev on 8787 and node mock-ls.mjs)
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";
const B = "http://localhost:8787";
const env = fs.readFileSync(new URL("../../site/.dev.vars", import.meta.url), "utf8");
const ADMIN = env.match(/^ADMIN_KEY=(.+)$/m)[1].trim();
const which = process.argv[2] || "chromium";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = async (fields) => {
  const body = new URLSearchParams({ key: ADMIN, ...fields });
  const r = await fetch(B + "/api/admin", { method: "POST", headers: { Origin: B, "Content-Type": "application/x-www-form-urlencoded" }, body });
  return r.text();
};
const grant = async (note) => { const h = await admin({ do: "grant", note, plan: "yearly", months: "12", devices: "1" }); return (h.match(/PDFE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0]; };
await fetch("http://127.0.0.1:8798/_reset", { method: "POST" });
await admin({ do: "shop", currency: "EUR", freeOcrPages: "3", storeId: "4242", monthly_price: "4", yearly_price: "29", lifetime_price: "59", lifetime: "on", monthly_variant: "901", yearly_variant: "902", lifetime_variant: "903" });
let total = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== name) continue;
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const b = await engine.launch();
  const newPage = async () => {
    const c = await b.newContext({ viewport: { width: 1300, height: 900 }, locale: "en-US", acceptDownloads: true });
    await c.addInitScript(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1"); });
    await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
    const p = await c.newPage(); p.__errs = []; p.on("pageerror", (e) => p.__errs.push(e.message));
    await p.goto(B + "/app/");
    await p.waitForFunction(() => document.body.classList.contains("engine-ready") && window.PRO, null, { timeout: 60000 });
    return p;
  };
  const waitFn = async (p, expr, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await p.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); } return false; };
  const open = async (p) => { await p.setInputFiles("#fileInput", pdf); await waitFn(p, "S.doc && pageEl(0).dataset.rkey"); };
  const activate = async (p, key) => {
    await p.evaluate(() => { PRO.open(); });
    await p.waitForSelector("#proDlg .pro-key");
    await p.fill("#proDlg .pro-key", key);
    await p.click("#proDlg .pro-activate");
    await waitFn(p, `!document.querySelector('#proDlg') || !document.querySelector('#proDlg .err').hidden`);
    const e = await p.evaluate(() => { const x = document.querySelector("#proDlg .err"); return x && !x.hidden ? x.textContent : ""; });
    if (e) await p.keyboard.press("Escape");
    return e;
  };
  try {
    // ---- free: the Pro window, prices from the admin page, closed shop
    const p1 = await newPage();
    await open(p1);
    ok(await p1.evaluate(() => !PRO.has("batch")), "without a licence, Pro is off");
    await p1.evaluate(() => { PROTOOLS.batch(); });
    ok(await waitFn(p1, `document.querySelector('#proDlg')`), "a Pro feature opens the Pro window");
    let txt = (await p1.textContent("#proDlg")).replace(/\s+/g, " ");
    ok(/“Batch processing” is part of Pro/.test(txt) && /not on sale yet/.test(txt) && !/Buy/.test(txt), "shop closed: no prices or Buy buttons, a licence key can still be entered");
    await p1.keyboard.press("Escape");
    // the shop cannot open while the business is not registered
    const refused = await admin({ do: "shop", sales: "on", currency: "EUR", storeId: "4242", monthly_price: "4", yearly_price: "29", lifetime_price: "59", lifetime: "on" });
    ok(/The shop stays closed/.test(refused), "the admin page refuses to open the shop without the business details");
    // ---- a free licence
    const code = await grant("test " + name);
    ok(/^PDFE-/.test(code || ""), "admin: a free licence code is created: " + code);
    let e = await activate(p1, code);
    ok(!e && await p1.evaluate(() => PRO.has("batch") && document.documentElement.classList.contains("is-pro")), "the code activates Pro in this browser" + (e ? " – " + e : ""));
    await p1.reload(); await waitFn(p1, "window.PRO"); await p1.evaluate(() => PRO.ready);
    ok(await p1.evaluate(() => PRO.has("forms")), "Pro is still active after a reload");
    // a forged token (edited plan) is refused
    const forged = await p1.evaluate(async () => {
      const lic = JSON.parse(localStorage.getItem("pdfe.pro")), [body, sig] = lic.token.split(".");
      const c = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
      c.until = null; c.plan = "lifetime"; c.exp = Date.now() + 1e12;
      const nb = btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return { ...lic, token: nb + "." + sig };
    });
    const p2 = await newPage();
    await p2.evaluate((l) => { localStorage.setItem("pdfe.pro", JSON.stringify(l)); }, forged);
    await p2.reload(); await waitFn(p2, "window.PRO"); await p2.evaluate(() => PRO.ready);
    ok(await p2.evaluate(() => !PRO.has("batch")), "a licence edited by hand (forged token) is refused");
    // copying the licence to another browser: refused (bound to the first one)
    await p2.evaluate((l) => { localStorage.setItem("pdfe.pro", JSON.stringify(l)); }, JSON.parse(await p1.evaluate(() => localStorage.getItem("pdfe.pro"))));
    await p2.reload(); await waitFn(p2, "window.PRO"); await p2.evaluate(() => PRO.ready);
    ok(await p2.evaluate(() => !PRO.has("batch")), "the licence copied into another browser does not work there");
    // the same code on a second computer: refused while the first one uses it
    e = await activate(p2, code);
    ok(/already used on another computer/.test(e), "the same code on a 2nd computer is refused: " + e);
    // release on the first, then the second can use it
    await p1.evaluate(() => { PRO.open(); });
    await p1.waitForSelector("#proDlg .pro-release"); await p1.click("#proDlg .pro-release");
    await p1.waitForSelector("#modal:not([hidden])"); await p1.click("#modalOk");
    await waitFn(p1, "!PRO.state");
    ok(await p1.evaluate(() => !PRO.has("batch")), "“Release this computer”: Pro stops on the 1st computer");
    e = await activate(p2, code);
    ok(!e && await p2.evaluate(() => PRO.has("batch")), "…and the code now works on the 2nd one" + (e ? " – " + e : ""));
    // cancelling the licence on the admin page stops it at its next check
    await admin({ do: "revoke", code });
    await p2.evaluate(() => { const l = JSON.parse(localStorage.getItem("pdfe.pro")); const [b] = l.token.split("."); l.token = l.token; localStorage.setItem("pdfe.pro", JSON.stringify(l)); });
    const r = await p2.evaluate(async () => (await fetch("/api/pro/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(localStorage.getItem("pdfe.pro")), device: localStorage.getItem("pdfe.device") }) })).json());
    ok(r.gone && /cancelled/.test(r.error), "a cancelled licence is refused at its next check: " + r.error);
    // ---- a Lemon Squeezy key (fake store)
    await fetch("http://127.0.0.1:8798/_reset", { method: "POST" });
    const p3 = await newPage(); await open(p3);
    e = await activate(p3, "22222222-2222-4222-8222-222222222222");
    ok(!e && await p3.evaluate(() => PRO.state && PRO.state.plan === "yearly"), "a bought key (Lemon Squeezy) activates the yearly plan" + (e ? " – " + e : ""));
    const p4 = await newPage();
    ok(/already used on another computer/.test(await activate(p4, "22222222-2222-4222-8222-222222222222")), "the bought key on a 2nd computer: refused (activation limit 1)");
    ok(/not valid/.test(await activate(p4, "55555555-5555-4555-8555-555555555555")), "a key from another shop: refused");
    ok(/ended/.test(await activate(p4, "44444444-4444-4444-8444-444444444444")), "an expired key: refused");
    // ---- the Pro features (on p3, Pro active)
    // smart redaction
    await p3.evaluate(async () => { applyInfo(await call("addText", 0, 60, 600, "Write to jane.doe@example.com or call +33 6 12 34 56 78", { size: 10 })); });
    await p3.evaluate(() => REDACT.start());
    await p3.waitForSelector("#redactBar .rb-smart");
    await p3.click("#redactBar .rb-smart");
    ok(await waitFn(p3, `REDACT.marks.length === 2`), "smart redaction: the email and the phone number are marked (" + await p3.evaluate(() => REDACT.marks.length) + ")");
    await p3.click("#redactBar .rb-cancel");
    // forms: add a field, fill it
    await p3.evaluate(async () => { applyInfo(await call("addField", 0, [300, 640, 520, 662], "text", "Name")); });
    await waitFn(p3, `document.querySelector('#pages .page .ffield')`);
    await p3.evaluate(() => document.querySelector("#pages .page .ffield").scrollIntoView({ block: "center" })); await sleep(300);
    const fb = await p3.evaluate(() => { const r = document.querySelector("#pages .page .ffield").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await p3.mouse.click(...fb);
    await p3.waitForSelector(".ff-input"); await p3.keyboard.type("Jane Doe"); await p3.keyboard.press("Enter");
    ok(await waitFn(p3, `call("formFields", 0).then((f) => f[0] && f[0].value === "Jane Doe")`), "forms: a field is added and filled in on the page");
    // compare with the original
    const cmp = await p3.evaluate(async (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); return call("compareWith", bytes); }, fs.readFileSync(pdf).toString("base64"));
    ok(cmp.pages[0].added.some((x) => /jane\.doe/.test(x.text)), "compare: the added line is reported as new");
    // OCR: no page limit with Pro
    ok(await p3.evaluate(async () => (await PROTOOLS.ocrPages([0, 1, 2, 3, 4, 5])).length === 6), "OCR with Pro: no page limit");
    // batch: compress 2 files in the background (the open PDF untouched)
    const bo = await p3.evaluate(async (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const r = await call("batchOne", "numbers", { name: "a.pdf", bytes }, { format: "{n} / {total}" }); const m = await call("batchMerge", [{ name: "a.pdf", bytes }, { name: "b.pdf", bytes: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }]); return { n: r.bytes.length, pages: m.pages, open: S.doc.pages.length }; }, fs.readFileSync(pdf).toString("base64"));
    ok(bo.n > 1000 && bo.pages === 2 && bo.open === 1, "batch: page numbers on a file and a merge, without touching the open PDF");
    // ---- without Pro: OCR limited to the free pages
    const p5 = await newPage(); await open(p5);
    const choice = p5.evaluate(() => PROTOOLS.ocrPages([0, 1, 2, 3, 4, 5]));
    await p5.waitForSelector("#ocrLimitDlg"); await p5.check('#ocrLimitDlg input[value="free"]'); await p5.click("#ocrLimitDlg .td-ok");
    ok((await choice).length === 3, "OCR without Pro: limited to 3 pages per PDF (the free choice)");
    // ---- prices and the lifetime switch (admin page)
    await admin({ do: "shop", currency: "EUR", freeOcrPages: "3", storeId: "4242", monthly_price: "5", yearly_price: "39", lifetime_price: "79", monthly_variant: "901", yearly_variant: "902", lifetime_variant: "903" });
    const cfg = await (await fetch(B + "/api/pro/config")).json();
    ok(cfg.plans.map((x) => x.id + x.price).join(",") === "monthly5,yearly39" && !cfg.sales, "admin: new prices, lifetime turned off for new buyers: " + JSON.stringify(cfg.plans));
    ok(!(await activate(p4, "33333333-3333-4333-8333-333333333333")), "a lifetime key bought before still activates after the offer is turned off");
    for (const p of [p1, p2, p3, p4, p5]) ok(!p.__errs.length, "no script errors " + p.__errs.slice(0, 2).join(" | "));
  } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n").slice(0, 12).join(" / ")}`); }
  await b.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  total += fails;
}
// put the default settings back
await admin({ do: "shop", currency: "EUR", freeOcrPages: "3", storeId: "", monthly_price: "4", yearly_price: "29", lifetime_price: "59", lifetime: "on" });
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
