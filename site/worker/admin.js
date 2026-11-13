// PDF Editor - the publisher's admin page: /api/admin?key=ADMIN_KEY (404 without the key).
// Prices, plans, the lifetime offer, opening the shop, free licences, discount codes. Plain HTML forms,
// no script; every change is a POST from this page (other origins are refused).
import { getSettings, saveSettings, PLANS, newGrantCode } from "./pro.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PLAN_NAME = { monthly: "Monthly", yearly: "Yearly", lifetime: "Lifetime (at least 2 years)" };

function keyOk(env, given) {
  const key = env.ADMIN_KEY || "";
  if (key.length < 24 || !given || given.length !== key.length) return false;
  let d = 0;
  for (let i = 0; i < key.length; i++) d |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}
/** Is the publisher's business registered (site/site.json, published with the site)? Selling needs it. */
async function business(env, request) {
  try {
    const r = await env.ASSETS.fetch(new Request(new URL("/app/pro-site.json", request.url)));
    return r.ok ? await r.json() : { registered: false };
  } catch (e) { return { registered: false }; }
}

async function createDiscount(env, s, f) {
  if (!env.LS_API_KEY || !s.storeId) return "Set the Lemon Squeezy store ID above and the LS_API_KEY secret first.";
  const code = (f.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || ("GIFT" + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase());
  const pct = f.get("type") === "percent", amount = Math.round(Number(f.get("amount")) * (pct ? 1 : 100));
  if (!(amount > 0) || (pct && amount > 100)) return "Enter a discount amount (a percentage up to 100, or an amount).";
  const uses = Math.max(1, Math.min(1000, Number(f.get("uses")) || 1)), until = f.get("until");
  const body = { data: { type: "discounts", attributes: {
    name: (f.get("note") || "Discount " + code).slice(0, 80), code, amount, amount_type: pct ? "percent" : "fixed",
    is_limited_redemptions: true, max_redemptions: uses, expires_at: until ? new Date(until + "T23:59:59Z").toISOString() : null,
    duration: f.get("duration") === "forever" ? "forever" : "once",
  }, relationships: { store: { data: { type: "stores", id: String(s.storeId) } } } } };
  const r = await fetch((env.LS_API || "https://api.lemonsqueezy.com") + "/v1/discounts", { method: "POST",
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json", Authorization: "Bearer " + env.LS_API_KEY }, body: JSON.stringify(body) });
  if (!r.ok) { let m = ""; try { m = ((await r.json()).errors || [])[0].detail; } catch (e) {} return "Lemon Squeezy refused the discount: " + (m || r.status); }
  return `Discount code created: ${code} (${pct ? amount + "%" : (amount / 100).toFixed(2) + " " + s.currency} off, ${uses} use${uses > 1 ? "s" : ""}). Give it to the person; it works at checkout.`;
}

async function act(env, request, f, s, biz) {
  const what = f.get("do");
  if (what === "shop") {
    const wantSales = f.get("sales") === "on";
    if (wantSales && !biz.registered) return "The shop stays closed: fill in the business details in site/site.json (business.registered: true, SIRET, address, mediator), rebuild and deploy the site first.";
    s.sales = wantSales; s.lifetime = f.get("lifetime") === "on";
    s.currency = (f.get("currency") || "EUR").toUpperCase().slice(0, 3);
    s.freeOcrPages = Math.max(0, Math.min(1000, Number(f.get("freeOcrPages")) || 0));
    s.storeId = (f.get("storeId") || "").replace(/\D/g, "");
    for (const p of PLANS) s.plans[p] = {
      price: Math.max(0, Number(String(f.get(p + "_price") || "0").replace(",", ".")) || 0),
      checkout: (f.get(p + "_checkout") || "").trim().slice(0, 300),
      variant: (f.get(p + "_variant") || "").replace(/\D/g, ""),
    };
    for (const p of PLANS) if (s.plans[p].checkout && !/^https:\/\/[a-z0-9.-]+\.lemonsqueezy\.com\//i.test(s.plans[p].checkout)) return `The ${p} checkout link must be a Lemon Squeezy link (https://….lemonsqueezy.com/…).`;
    await saveSettings(env, s);
    return "Saved. The site shows the new settings within a minute.";
  }
  if (what === "grant") {
    const code = newGrantCode(), months = Number(f.get("months")) || 0, plan = PLANS.includes(f.get("plan")) ? f.get("plan") : "yearly";
    const until = months > 0 ? Date.now() + months * 30.44 * 86400000 : null;
    const devices = Math.max(1, Math.min(10, Number(f.get("devices")) || 1));
    await env.DB.prepare("INSERT INTO grants (code, note, plan, until, max_devices, created) VALUES (?, ?, ?, ?, ?, ?)").bind(code, (f.get("note") || "").slice(0, 120), plan, until, devices, Date.now()).run();
    return `Free licence created: ${code} — give this code to the person; they enter it in the editor (Tools → Pro).`;
  }
  if (what === "revoke" || what === "restore") {
    await env.DB.prepare("UPDATE grants SET revoked = ? WHERE code = ?").bind(what === "revoke" ? 1 : 0, f.get("code")).run();
    return what === "revoke" ? "Licence cancelled: it stops working at its next check (within 10 days)." : "Licence restored.";
  }
  if (what === "free") {
    await env.DB.prepare("DELETE FROM grant_devices WHERE code = ?").bind(f.get("code")).run();
    return "Its computers were released: the code can be activated again.";
  }
  if (what === "discount") return createDiscount(env, s, f);
  return "";
}

function page(s, biz, key, msg, grants) {
  const k = `<input type="hidden" name="key" value="${esc(key)}">`;
  const plansRows = PLANS.map((p) => `<tr><th>${esc(PLAN_NAME[p])}</th>
    <td><input name="${p}_price" value="${esc(s.plans[p].price)}" inputmode="decimal" size="6"> ${esc(s.currency)}${p === "monthly" ? " / month" : p === "yearly" ? " / year" : " once"}</td>
    <td><input name="${p}_checkout" value="${esc(s.plans[p].checkout)}" placeholder="https://yourstore.lemonsqueezy.com/buy/…" size="44"></td>
    <td><input name="${p}_variant" value="${esc(s.plans[p].variant)}" placeholder="variant ID" size="9"></td></tr>`).join("");
  const fmt = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "no end");
  const grantRows = grants.map((g) => `<tr class="${g.revoked ? "off" : ""}"><td><code>${esc(g.code)}</code></td><td>${esc(g.note)}</td><td>${esc(g.plan)}</td><td>${fmt(g.until)}</td>
    <td>${g.n}/${g.max_devices}</td><td>${g.revoked ? "cancelled" : "active"}</td>
    <td><form method="post">${k}<input type="hidden" name="code" value="${esc(g.code)}"><button name="do" value="${g.revoked ? "restore" : "revoke"}">${g.revoked ? "Restore" : "Cancel"}</button> <button name="do" value="free"${g.n ? "" : " disabled"}>Release its computers</button></form></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Admin – PDF Editor Pro</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d2129;--muted:#6b7280;--line:#e3e6ea;--card:#f7f8fa;--accent:#e5322d}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e8eaed;--muted:#9aa0a6;--line:#30343a;--card:#1c1f23}}
body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:1150px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0 0 10px}section{background:var(--card);border-radius:12px;padding:16px;margin:16px 0}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
input,select,button{font:inherit;padding:5px 8px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}button{cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.msg{padding:10px 14px;border-radius:10px;background:#fef3c7;color:#713f12;font-weight:600}
.small{color:var(--muted);font-size:13px}.off td{opacity:.5}label{margin-right:16px}.warn{color:#b45309}
</style></head><body><main>
<h1>PDF Editor Pro – admin</h1><p class="small">Only you can open this page (keep its link private). Prices and switches take effect on the site within a minute.</p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ""}
<section><h2>Shop and prices</h2><form method="post">${k}<input type="hidden" name="do" value="shop">
<p><label><input type="checkbox" name="sales"${s.sales ? " checked" : ""}${biz.registered ? "" : " disabled"}> <b>Shop open</b> (Buy buttons on the site)</label>
${biz.registered ? "" : `<span class="warn">Closed until the business details are in site/site.json (business.registered) and the site is redeployed.</span>`}</p>
<p><label><input type="checkbox" name="lifetime"${s.lifetime ? " checked" : ""}> Offer the <b>lifetime</b> plan to new buyers</label>
<span class="small">Turning it off hides it on the site; lifetime licences already sold keep working. Also unpublish its variant in Lemon Squeezy so old links stop selling it.</span></p>
<table><tr><th>Plan</th><th>Price shown</th><th>Lemon Squeezy checkout link</th><th>Variant ID</th></tr>${plansRows}</table>
<p class="small">The price charged is the one set in Lemon Squeezy: keep both the same. A plan with price 0 is not shown.</p>
<p><label>Currency <input name="currency" value="${esc(s.currency)}" size="4"></label>
<label>Lemon Squeezy store ID <input name="storeId" value="${esc(s.storeId)}" size="9"></label>
<label>OCR without Pro: up to <input name="freeOcrPages" value="${esc(s.freeOcrPages)}" size="3"> pages per PDF</label></p>
<p><button class="primary">Save</button></p></form></section>
<section><h2>Give a free licence</h2><form method="post">${k}<input type="hidden" name="do" value="grant">
<label>For (your note) <input name="note" size="26" placeholder="e.g. Jane – beta tester"></label>
<label>Plan <select name="plan">${PLANS.map((p) => `<option value="${p}"${p === "yearly" ? " selected" : ""}>${p}</option>`).join("")}</select></label>
<label>Lasts <select name="months"><option value="1">1 month</option><option value="3">3 months</option><option value="12" selected>1 year</option><option value="0">no end</option></select></label>
<label>Computers <input name="devices" value="1" size="2"></label> <button class="primary">Create a code</button></form>
${grants.length ? `<table><tr><th>Code</th><th>For</th><th>Plan</th><th>Until</th><th>Computers</th><th>State</th><th></th></tr>${grantRows}</table>` : `<p class="small">No free licence yet.</p>`}</section>
<section><h2>Give a discount</h2><form method="post">${k}<input type="hidden" name="do" value="discount">
<label>For (note) <input name="note" size="20"></label><label>Code <input name="code" size="12" placeholder="automatic"></label>
<label><select name="type"><option value="percent">%</option><option value="fixed">${esc(s.currency)}</option></select> <input name="amount" size="5" placeholder="20"></label>
<label>Uses <input name="uses" value="1" size="3"></label><label>Until <input type="date" name="until"></label>
<label>On subscriptions <select name="duration"><option value="once">first payment</option><option value="forever">every payment</option></select></label>
<button class="primary">Create</button></form>
<p class="small">Made in your Lemon Squeezy store (needs the store ID and the LS_API_KEY secret). You can also create and delete codes in the Lemon Squeezy dashboard.</p></section>
<p class="small">Licences from Lemon Squeezy: set each product's licence key <b>activation limit to 1</b> so a key works on one computer at a time. Refunds, cancellations and invoices are in the Lemon Squeezy dashboard.</p>
</main></body></html>`;
}

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
  let key = url.searchParams.get("key") || "", msg = "", f = null;
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403 });
    f = await request.formData();
    key = f.get("key") || "";
  }
  if (!keyOk(env, key)) return new Response("Not found", { status: 404 });
  const s = await getSettings(env), biz = await business(env, request);
  if (f) msg = await act(env, request, f, s, biz);
  const grants = (await env.DB.prepare(`SELECT g.*, (SELECT COUNT(*) FROM grant_devices d WHERE d.code = g.code) AS n FROM grants g ORDER BY created DESC LIMIT 200`).all()).results;
  return new Response(page(await getSettings(env), biz, key, msg, grants), { headers });
}
