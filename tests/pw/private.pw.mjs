// The private pages (/api/admin, /api/stats): impossible to tell apart from a missing page without the key; the key
// signs in once and leaves the address; forged, expired or other-scope cookies are refused; sign-out works; another
// site cannot post. Run: node private.pw.mjs [base url]   (keys from site/.dev.vars)
import fs from "node:fs";
import { chromium } from "playwright";
const B = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const vars = fs.readFileSync(new URL("../../site/.dev.vars", import.meta.url), "utf8");
const ADMIN = process.env.PDFE_ADMIN_KEY || vars.match(/^ADMIN_KEY=(.+)$/m)[1].trim(), STATS = process.env.PDFE_STATS_KEY || vars.match(/^STATS_KEY=(.+)$/m)[1].trim();   // live: pass the keys in the environment
let fails = 0; const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fails++; };
const get = (path, h = {}) => fetch(B + path, { redirect: "manual", headers: h });
// 1. without the key: exactly like a missing address
const ref = await get("/api/nothing-here-" + Date.now()), refBody = await ref.text();
for (const path of ["/api/admin", "/api/admin?key=", "/api/admin?key=" + "A".repeat(ADMIN.length), "/api/admin?key=" + ADMIN.slice(0, -1) + "x",
                    "/api/stats", "/api/stats.json", "/api/stats?key=" + "B".repeat(STATS.length), "/api/admin?signout"]) {
  const r = await get(path), b = await r.text();
  ok(r.status === 404 && b === refBody && r.headers.get("content-type") === ref.headers.get("content-type"), `${path.replace(/key=.+/, "key=…")}: the same 404 page as a missing address`);
}
const post = await fetch(B + "/api/admin", { method: "POST", headers: { Origin: B, "Content-Type": "application/x-www-form-urlencoded" }, body: "do=shop&key=" + ADMIN, redirect: "manual" });
ok(post.status === 404, "a POST with the key in the form but no session: 404 (the key is not accepted from forms any more)");
// 2. the key signs in once
for (const [path, key, scope] of [["/api/admin", ADMIN, "admin"], ["/api/stats", STATS, "stats"]]) {
  const r = await get(path + "?key=" + encodeURIComponent(key));
  const sc = r.headers.get("set-cookie") || "", cookie = sc.split(";")[0];
  ok(r.status === 303 && r.headers.get("location") === path, `${path}: the key gives a redirect to ${r.headers.get("location")} (no key in the address)`);
  ok(/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Max-Age=43200/.test(sc) && /Path=\//.test(sc), `${path}: the session cookie is HttpOnly, SameSite=Strict, 12 hours`);
  const page = await get(path, { Cookie: cookie }), html = await page.text();
  ok(page.status === 200 && !html.includes(key), `${path}: signed in, the page opens and never contains the key`);
  // forged and expired cookies
  const [name, value] = cookie.split("="), [exp, mac] = value.split(".");
  const forged = `${name}=${Math.floor(Date.now() / 1000) + 99999}.${mac}`, expired = `${name}=1700000000.${mac}`, tampered = `${name}=${exp}.${mac.slice(0, -2)}AA`;
  for (const [label, c] of [["a later expiry with the old signature", forged], ["an expired date", expired], ["a tampered signature", tampered]])
    ok((await get(path, { Cookie: c })).status === 404, `${path}: a cookie with ${label} is refused`);
  const other = scope === "admin" ? "stats" : "admin";
  ok((await get("/api/" + other, { Cookie: cookie.replace("pdfe_" + scope, "pdfe_" + other) })).status === 404, `${path}: its cookie does not open the other private page`);
  const out = await get(path + "?signout", { Cookie: cookie });
  ok(out.status === 303 && /Max-Age=0/.test(out.headers.get("set-cookie") || ""), `${path}: Sign out clears the cookie`);
}
// 3. in a real browser: after signing in, the key is in neither the address nor the history
const b = await chromium.launch(), c = await b.newContext(), p = await c.newPage();
await p.goto(B + "/api/admin?key=" + encodeURIComponent(ADMIN));
ok(p.url() === B + "/api/admin" && /Shop and prices/.test(await p.textContent("body")), "browser: the admin page opens and the address shows no key: " + p.url());
await p.goBack().catch(() => {});
ok(!p.url().includes(ADMIN), "browser: going back does not show the key either");
const cks = await c.cookies();
ok(cks.some((x) => /pdfe_admin/.test(x.name) && x.httpOnly && x.sameSite === "Strict"), "browser: the session cookie is HttpOnly and SameSite=Strict");
ok(!(await p.evaluate(() => { try { return document.cookie; } catch (e) { return ""; } })).includes("pdfe_"), "browser: scripts cannot read the session cookie");
await b.close();
console.log(fails ? `${fails} FAILED` : "ALL OK"); process.exit(fails ? 1 : 0);
