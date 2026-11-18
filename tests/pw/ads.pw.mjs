// Ads with consent: nothing from Google before "Accept", the banner on the home page only, "Refuse" as easy as "Accept",
// "Cookie settings" withdraws consent, the editor never loads any of it, the pages say so. Google's script is a stub here.
// Builds the site with a test publisher id, then rebuilds it as configured. Run: node ads.pw.mjs [chromium|firefox|webkit|all]
import { execFileSync } from "node:child_process";
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all", B = "http://localhost:8787", SITE = new URL("../../site/", import.meta.url).pathname;
const build = (env) => execFileSync("python3", ["../tools/build_site.py"], { cwd: SITE, env: { ...process.env, ...env }, stdio: "pipe" });
build({ PDFE_ADS_CLIENT: "ca-pub-1234567890123456", PDFE_ADS_SLOT: "1234567890", PDFE_ADS_CONSENT: "open-source" });
await new Promise((r) => setTimeout(r, 2500));                       // the local server picks up the new files
let total = 0;
try {
  for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
    if (which !== "all" && which !== name) continue;
    let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
    const b = await engine.launch();
    const ctx = async (locale = "en-US") => {
      const c = await b.newContext({ locale, viewport: { width: 1280, height: 900 } });
      c.google = [];
      await c.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));   // the banner hides itself from bots
      await c.route(/googlesyndication\.com|doubleclick\.net|adtrafficquality|google\.com\/(pagead|adsid)/, (r) => { c.google.push(r.request().url()); r.fulfill({ status: 200, contentType: "text/javascript", body: "window.__adsLoaded = (window.__adsLoaded || 0) + 1;" }); });
      await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
      return c;
    };
    try {
      // 1. first visit: banner, nothing from Google
      let c = await ctx(), p = await c.newPage();
      await p.goto(B + "/"); await p.waitForSelector("#cc-main .cm", { timeout: 15000 });
      const btns = await p.evaluate(() => [...document.querySelectorAll("#cc-main .cm button")].map((x) => ({ t: x.textContent.trim(), cls: x.className, role: x.dataset.role })));
      ok(c.google.length === 0, "first visit: the banner shows and nothing is requested from Google");
      const acc = btns.find((x) => x.role === "all"), rej = btns.find((x) => x.role === "necessary");
      ok(acc && rej && acc.t === "Accept" && rej.t === "Refuse", "the banner offers Accept and Refuse: " + btns.map((x) => x.t).join(" / "));
      const sizes = await p.evaluate(() => { const s = (r) => { const e = document.querySelector(`#cc-main .cm button[data-role="${r}"]`).getBoundingClientRect(); return [Math.round(e.width), Math.round(e.height)]; }; return [s("all"), s("necessary")]; });
      ok(Math.abs(sizes[0][0] - sizes[1][0]) <= 2 && sizes[0][1] === sizes[1][1], `Refuse is as easy to click as Accept (${sizes[0]} vs ${sizes[1]})`);
      ok(await p.isHidden(".ad-slot"), "no empty ad box before consent");
      // 2. refuse: nothing, and the choice is remembered
      await p.click('#cc-main .cm button[data-role="necessary"]'); await new Promise((r) => setTimeout(r, 600));
      await p.reload(); await new Promise((r) => setTimeout(r, 1200));
      ok(c.google.length === 0 && !(await p.isVisible("#cc-main .cm")), "after Refuse: still nothing from Google, and the banner does not come back");
      await c.close();
      // 3. accept: the ad script loads, the ad box appears with its label
      c = await ctx(); p = await c.newPage();
      await p.goto(B + "/"); await p.waitForSelector("#cc-main .cm");
      await p.click('#cc-main .cm button[data-role="all"]');
      await p.waitForFunction(() => window.__adsLoaded >= 1, null, { timeout: 10000 });
      ok(c.google.some((u) => /adsbygoogle\.js\?client=ca-pub-1234567890123456/.test(u)), "after Accept: AdSense is loaded with the publisher id");
      ok(await p.isVisible(".ad-slot") && (await p.textContent(".ad-slot .ad-label")).trim() === "Advertisement", "the ad box shows, labelled as covering the site's costs");
      // 4. withdraw from the footer link: reload without Google
      await p.goto(B + "/privacy");
      const before = c.google.length;
      await p.click("#ccSettings"); await p.waitForSelector("#cc-main .pm", { state: "visible" });
      await p.click('#cc-main .pm button[data-role="necessary"]');
      await p.waitForLoadState("load"); await new Promise((r) => setTimeout(r, 1200));
      await p.goto(B + "/"); await new Promise((r) => setTimeout(r, 1500));
      ok(c.google.length === before && await p.isHidden(".ad-slot"), "Cookie settings → Refuse: consent withdrawn, nothing from Google any more");
      await c.close();
      // 5. other pages and the editor
      c = await ctx(); p = await c.newPage();
      await p.goto(B + "/privacy"); await new Promise((r) => setTimeout(r, 1500));
      ok(!(await p.isVisible("#cc-main .cm")) && c.google.length === 0, "privacy page: no banner (no ad there), nothing from Google");
      const priv = await p.textContent("main");
      ok(/Advertising/.test(priv) && /Google AdSense/.test(priv) && /consent/.test(priv) && !/no cookies and no ads/.test(priv), "the privacy page describes the ad, Google and consent; the old “no ads” claim is gone");
      await p.goto(B + "/cookies");
      ok(/advertising cookies only if you agree/.test(await p.textContent("main")) && !/uses no cookies/.test(await p.textContent("main")), "the cookies page lists the advertising cookies");
      await p.goto(B + "/");
      ok(!/no tracking/.test(await p.textContent("#privacy")), "home page: the “no tracking” claim is gone");
      await p.goto(B + "/app/"); await new Promise((r) => setTimeout(r, 2500));
      ok(!(await p.$("#cc-main")) && !(await p.$('script[src*="ads.js"]')) && c.google.length === 0, "the editor: no banner, no ad script, nothing from Google");
      const h = (await (await p.request.get(B + "/")).headers())["content-security-policy"] || "", ha = (await (await p.request.get(B + "/app/")).headers())["content-security-policy"] || "";
      ok(/frame-src https:/.test(h) && !/https:/.test(ha.split(";").find((x) => /script-src/.test(x)) || ""), "site pages allow Google's ads; the editor keeps its strict policy");
      ok(/^google\.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0$/m.test(await (await p.request.get(B + "/ads.txt")).text()), "ads.txt is served");
      await c.close();
      // 6. Arabic: translated and right to left
      c = await ctx("ar"); p = await c.newPage();
      await p.goto(B + "/ar/"); await p.waitForSelector("#cc-main .cm");
      const ar = await p.evaluate(() => ({ dir: getComputedStyle(document.querySelector("#cc-main .cm")).direction, t: document.querySelector("#cc-main .cm__title").textContent }));
      ok(ar.dir === "rtl" && /إعلان/.test(ar.t), "Arabic: the banner is translated and right to left: " + ar.t);
      await c.close();
    } catch (x) { fails++; console.log(`  FAIL [${name}] exception: ${x.message.split("\n")[0]}`); }
    await b.close(); console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
  }
  // ---- Google's certified consent message (ads.consent = "google"), in Chromium
  if (which === "all" || which === "chromium") {
    build({ PDFE_ADS_CLIENT: "ca-pub-1234567890123456", PDFE_ADS_SLOT: "1234567890", PDFE_ADS_CONSENT: "google" });
    await new Promise((r) => setTimeout(r, 2500));
    let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [google mode] ${m}`); if (!c) fails++; };
    const b = await chromium.launch();
    try {
      const c = await b.newContext({ locale: "en-US" }); c.google = [];
      await c.route(/googlesyndication\.com|doubleclick\.net|fundingchoicesmessages|google\.com\/(pagead|adsid)/, (r) => { c.google.push(r.request().url()); r.fulfill({ status: 200, contentType: "text/javascript", body: "window.__adsLoaded = (window.__adsLoaded || 0) + 1;" }); });
      await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));
      const p = await c.newPage();
      await p.goto(B + "/privacy"); await new Promise((r) => setTimeout(r, 1500));
      ok(c.google.length === 0 && !(await p.$("#cc-main")), "privacy page: no banner of ours and nothing from Google");
      const priv = await p.textContent("main");
      ok(/Google's own consent message/.test(priv) && /loads on the home page before you choose/.test(priv) && /limited, non-personalised ad/.test(priv), "the privacy page describes Google's message, the script loading before the choice, and limited ads");
      ok(!/only if you accept advertising cookies in the banner/.test(priv), "…and not the open-source banner's wording");
      await Promise.all([p.waitForURL(/#consent$/), p.click("#ccSettings")]);
      ok(new URL(p.url()).pathname === "/" && p.url().endsWith("#consent"), "Cookie settings on another page leads to the home page, where Google's message lives: " + p.url());
      await p.waitForFunction(() => window.__adsLoaded >= 1, null, { timeout: 10000 });
      ok(c.google.some((u) => /adsbygoogle\.js\?client=ca-pub-1234567890123456/.test(u)) && await p.isVisible(".ad-slot"), "home page: Google's script loads (it shows Google's message) and the ad box is there");
      ok(await p.evaluate(() => Array.isArray(window.googlefc && window.googlefc.callbackQueue) && window.googlefc.callbackQueue.length === 1), "#consent: Google's message is asked to reopen (showRevocationMessage queued)");
      await p.goto(B + "/cookies");
      ok(/FCCDCF/.test(await p.textContent("main")), "the cookies page lists the cookies of Google's message");
      await p.goto(B + "/app/"); const before = c.google.length; await new Promise((r) => setTimeout(r, 2500));
      ok(c.google.length === before && !(await p.$('script[src*="ads.js"]')), "the editor: nothing from Google");
      await c.close();
    } catch (x) { fails++; console.log(`  FAIL [google mode] exception: ${x.message.split("\n")[0]}`); }
    await b.close(); console.log(`  => google mode: ${fails ? fails + " FAILED" : "ALL OK"}`); total += fails;
  }
  // ---- verification only (publisher id, no ad slot yet): ads.txt and the meta tag, nothing loaded, wording unchanged
  {
    build({ PDFE_ADS_CLIENT: "ca-pub-1234567890123456", PDFE_ADS_CONSENT: "google" });
    await new Promise((r) => setTimeout(r, 2500));
    const home = await (await fetch(B + "/")).text(), txt = await (await fetch(B + "/ads.txt")).text();
    const v = /<meta name="google-adsense-account" content="ca-pub-1234567890123456">/.test(home) && !/ads\.js|cookieconsent|adsbygoogle/.test(home) && /no ads, no tracking/.test(home) && /pub-1234567890123456/.test(txt);
    console.log(`  ${v ? "ok  " : "FAIL"} [verification] publisher id without a slot: ads.txt and the meta tag only, no script, pages unchanged`); if (!v) total++;
  }
} finally { build({}); }
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK"); process.exit(total ? 1 : 0);
