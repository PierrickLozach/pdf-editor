// The website as a visitor uses it, in Chromium, Firefox and WebKit: landing page in English and
// French, first visit in the visitor's language, language switcher (remembered, also by the editor),
// legal pages, 404, no cookies, security headers, phone layout.
// Needs the local site (cd site && npm run dev). Run: node site.pw.mjs [chromium|firefox|webkit|all]
import fs from "node:fs";
import { chromium, firefox, webkit } from "playwright";

const BASE = process.argv[3] || "http://127.0.0.1:8787";
const which = process.argv[2] || "all";
const OUT = "/tmp/pdfe-site";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;

async function run(name) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await { chromium, firefox, webkit }[name].launch();
  const errs = [];
  const watch = (p) => {
    p.on("pageerror", (e) => errs.push(e.message));
    // (screenshots: the test tool injects a stylesheet that the site's strict policy refuses – expected)
    p.on("console", (m) => { if (m.type() === "error" && !/status of 404|Refused to apply a stylesheet/.test(m.text())) errs.push(`${p.url()}: ${m.text()}`); });
    return p;
  };
  try {
    // ---------------------------------------------------------------- no policy violation on normal page loads
    {
      const c0 = await browser.newContext();
      const q = await c0.newPage();
      const v = [];
      await q.exposeFunction("__v", (x) => v.push(x));
      await q.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => window.__v(`${e.violatedDirective} ${e.blockedURI}`)));
      for (const u of ["/", "/fr/privacy", "/app/"]) { await q.goto(BASE + u); await sleep(u === "/app/" ? 2500 : 600); }
      ok(v.length === 0, "no Content-Security-Policy violation when loading the pages and the editor " + v.slice(0, 3).join(" | "));
      await c0.close();
    }

    // ---------------------------------------------------------------- English visitor
    const en = await browser.newContext({ locale: "en-US", viewport: { width: 1360, height: 900 } });
    let p = watch(await en.newPage());
    let r = await p.goto(BASE + "/");
    ok(r.status() === 200 && /Edit any PDF/.test(await p.textContent("h1")) && (await p.getAttribute("html", "lang")) === "en", "English visitor: English landing page");
    ok(!(await p.$(".cookie-notice")) && (await en.cookies()).length === 0, "no cookie and no cookie banner");
    const csp = r.headers()["content-security-policy"] || "";
    ok(/script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), "security headers on the pages");
    const hl = await p.evaluate(() => [...document.querySelectorAll('link[hreflang]')].map((l) => l.hreflang));
    ok(hl.length === 13 && hl.includes("ar") && hl.includes("ja") && hl.at(-1) === "x-default", "each page names its 12 language versions (search engines): " + hl.join(","));
    ok(await p.evaluate(() => { const i = document.querySelector(".shot img"); return i.complete && i.naturalWidth > 0; }), "editor screenshot loads");
    await p.screenshot({ path: `${OUT}/${name}-en.png` });
    for (const [path, rx] of [["/privacy", /Privacy/], ["/cookies", /Cookies/], ["/terms", /Terms of use/], ["/legal", /Legal notice/]]) {
      r = await p.goto(BASE + path);
      ok(r.status() === 200 && rx.test(await p.textContent("h1")), `${path}`);
    }
    r = await p.goto(BASE + "/no-such-page");
    ok(r.status() === 404 && /doesn't exist/.test(await p.textContent("h1")), "404 page");
    // switch to French from the privacy page: same page, in French, remembered
    await p.goto(BASE + "/privacy");
    await Promise.all([p.waitForURL(/\/fr\/privacy$/), p.selectOption("#langSwitch", "fr")]);
    ok(/Confidentialité/.test(await p.textContent("h1")) && (await p.getAttribute("html", "lang")) === "fr", "language switcher: same page in French");
    await p.goto(BASE + "/");
    ok(/\/fr\/$/.test(p.url()), "the choice is remembered (home page opens in French)");
    await p.goto(BASE + "/app/");
    await p.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
    ok((await p.textContent("#toolbar")).includes("Modifier le texte"), "…and the editor follows it");
    await p.selectOption("#langPick", "en");
    await p.waitForFunction(() => document.body.classList.contains("engine-ready") && document.documentElement.lang === "en", null, { timeout: 60000 });
    await p.goto(BASE + "/");
    ok(/Edit any PDF/.test(await p.textContent("h1")) && !/\/fr\//.test(p.url()), "switching back to English in the editor applies to the site too");
    await en.close();

    // ---------------------------------------------------------------- French visitor, first visit
    const fr = await browser.newContext({ locale: "fr-FR", viewport: { width: 1360, height: 900 } });
    p = watch(await fr.newPage());
    await p.goto(BASE + "/");
    await p.waitForURL(/\/fr\/$/);
    ok(/Modifiez n'importe quel PDF/.test(await p.textContent("h1")), "French visitor: sent to the French home page on the first visit");
    ok(/Ouvrir l'éditeur/.test(await p.textContent("#userArea")) && /Mentions légales/.test(await p.textContent("footer")), "French header and footer");
    ok(/novembre|décembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre/.test(await (await p.goto(BASE + "/fr/privacy")).text()), "dates in French");
    await p.screenshot({ path: `${OUT}/${name}-fr.png` });
    r = await p.goto(BASE + "/fr/nope");
    ok(r.status() === 404 && /n'existe pas/.test(await p.textContent("h1")), "French 404");
    await p.goto(BASE + "/terms");
    ok(/\/fr\/terms$/.test(p.url()), "an English link opens the French page for a French visitor");
    ok((await p.evaluate(() => localStorage.getItem("pdfe.lang"))) === null, "the detected language is not stored (the site keeps following the browser)");
    ok((await p.evaluate(() => document.querySelector("#langSwitch").value)) === "auto", "the switcher shows “Browser language”");
    await fr.close();

    // ---------------------------------------------------------------- Arabic and Japanese visitors
    for (const [loc, code, rx] of [["ar-SA", "ar", /[\u0600-\u06FF]/], ["he-IL", "he", /[\u0590-\u05FF]/], ["ja-JP", "ja", /[\u3040-\u30FF\u4E00-\u9FFF]/]]) {
      const c = await browser.newContext({ locale: loc, viewport: { width: 1360, height: 900 } });
      const g = watch(await c.newPage());
      await g.goto(BASE + "/");
      await g.waitForURL(new RegExp(`/${code}/$`));
      const rtl = code === "ar" || code === "he";
      ok(rx.test(await g.textContent("h1")) && (await g.getAttribute("html", "dir")) === (rtl ? "rtl" : "ltr"), `${loc} visitor: /${code}/ in that language${rtl ? ", right to left" : ""}`);
      if (rtl) {
        const side = await g.evaluate(() => { const b = document.querySelector(".brand").getBoundingClientRect(), u = document.querySelector("#userArea").getBoundingClientRect(); return b.left > u.left; });
        ok(side, `${code}: the header is mirrored (logo on the right)`);
        ok(!(await g.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), `${code}: no sideways scrolling`);
        await g.screenshot({ path: `${OUT}/${name}-${code}.png` });
      }
      await c.close();
    }

    // ---------------------------------------------------------------- phone
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: name !== "firefox", hasTouch: true, locale: "fr-FR" });
    p = watch(await m.newPage());
    await p.goto(BASE + "/fr/");
    ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "phone: the page fits the screen");
    ok(await p.isVisible("#langSwitch") && await p.isVisible("#userArea .btn.primary"), "phone: language and “Open the editor” visible");
    await p.screenshot({ path: `${OUT}/${name}-phone.png` });
    await m.close();
    ok(errs.length === 0, "no script errors " + errs.slice(0, 4).join(" | "));
  } catch (e) {
    fails++; console.log(`  FAIL [${name}] exception: ${e.message.split("\n")[0]}`);
  }
  await browser.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}\n`);
  return fails;
}

for (const n of which === "all" ? ["chromium", "firefox", "webkit"] : [which]) total += await run(n);
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
