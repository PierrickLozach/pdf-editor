// PDF Editor Pro - licences, checked on this server only (the code of the site is public; this file's
// secrets are not: LICENCE_KEY signs the licences, ADMIN_KEY opens the admin page, LS_API_KEY talks to
// Lemon Squeezy). Endpoints, for this site's own pages only (other origins are refused):
//   GET  /api/pro/config       prices and plans to show, switches (from the admin page)
//   POST /api/pro/activate     {key, device, name}  -> {token} | {error}
//   POST /api/pro/refresh      {key, instance, device} -> {token} | {error, gone}
//   POST /api/pro/release      {key, instance} -> {ok}   frees this computer for another one
// A licence works on ONE computer at a time: Lemon Squeezy keys have an activation limit (set it to 1
// on the product); free licences from the admin page have their own limit. The browser keeps a token
// signed here (ECDSA P-256), bound to its random device identifier, renewed every few days.

export const FEATURES = ["batch", "smartredact", "ocr", "compare", "forms"];
export const PLANS = ["monthly", "yearly", "lifetime"];
export const DEFAULTS = {
  sales: false,              // the shop is closed until the publisher opens it (admin page)
  lifetime: true,            // offer the lifetime plan to new buyers
  currency: "EUR",
  freeOcrPages: 3,           // OCR without Pro: up to this many pages per PDF
  storeId: "",               // Lemon Squeezy store: only its keys are accepted
  plans: {
    monthly: { price: 4, checkout: "", variant: "" },
    yearly: { price: 29, checkout: "", variant: "" },
    lifetime: { price: 59, checkout: "", variant: "" },
  },
};
const TOKEN_DAYS = 10, LS_DEFAULT = "https://api.lemonsqueezy.com";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function getSettings(env) {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'pro'").first().catch(() => null);
  let s = {};
  try { s = row ? JSON.parse(row.v) : {}; } catch (e) {}
  const plans = {};
  for (const p of PLANS) plans[p] = { ...DEFAULTS.plans[p], ...((s.plans || {})[p] || {}) };
  return { ...DEFAULTS, ...s, plans };
}
export async function saveSettings(env, s) {
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('pro', ?1) ON CONFLICT (k) DO UPDATE SET v = ?1").bind(JSON.stringify(s)).run();
}

/** What the pages may show: prices and checkout links, never the store's internals. */
export async function publicConfig(env) {
  const s = await getSettings(env);
  const plans = PLANS.filter((p) => p !== "lifetime" || s.lifetime).map((p) => ({
    id: p, price: Number(s.plans[p].price) || 0, checkout: s.sales && /^https:\/\//.test(s.plans[p].checkout) ? s.plans[p].checkout : "",
  })).filter((p) => p.price > 0);
  return { sales: !!s.sales, currency: s.currency, plans, freeOcrPages: Math.max(0, Number(s.freeOcrPages) || 0), features: FEATURES };
}

/* ---------------------------------------------------------------- signing */
let signer = null;
async function signingKey(env) {
  if (!signer) {
    if (!env.LICENCE_KEY) throw new Error("LICENCE_KEY is not set");
    signer = await crypto.subtle.importKey("jwk", JSON.parse(env.LICENCE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  return signer;
}
async function token(env, claims) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ v: 1, ...claims, iat: Date.now(), exp: Date.now() + TOKEN_DAYS * 86400000 })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env), new TextEncoder().encode(body));
  return body + "." + b64u(sig);
}

/* ---------------------------------------------------------------- Lemon Squeezy */
async function ls(env, path, params) {
  const r = await fetch((env.LS_API || LS_DEFAULT) + "/v1/licenses/" + path, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
  });
  let b = {};
  try { b = await r.json(); } catch (e) {}
  return b;
}
function planOf(s, meta) {
  for (const p of PLANS) if (s.plans[p].variant && String(s.plans[p].variant) === String(meta.variant_id)) return p;
  return /life/i.test(meta.variant_name || "") ? "lifetime" : /year|annu/i.test(meta.variant_name || "") ? "yearly" : "monthly";
}
const ourStore = (s, meta) => !s.storeId || String(meta && meta.store_id) === String(s.storeId);
const lsUntil = (k) => (k && k.expires_at ? Date.parse(k.expires_at) : null);

/* ---------------------------------------------------------------- free licences (admin page) */
const isGrant = (key) => /^PDFE(-[A-Z0-9]{4}){3}$/.test(key);
export function newGrantCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(12));
  const c = [...r].map((x) => A[x % A.length]).join("");
  return `PDFE-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

/* ---------------------------------------------------------------- endpoints */
const clean = (v, n) => String(v || "").trim().slice(0, n);
const ERR = {
  unknown: "This licence key is not valid.",
  limit: "This licence is already used on another computer. Release it there first (Pro window, “Release this computer”), or contact us.",
  expired: "This licence has ended.",
  revoked: "This licence was cancelled.",
  busy: "The licence could not be checked just now. Try again in a moment.",
};

async function activate(env, b) {
  const key = clean(b.key, 80).toUpperCase().replace(/\s+/g, ""), device = clean(b.device, 64), name = clean(b.name, 80);
  if (!key || !/^[a-f0-9]{32}$/.test(device)) return json({ error: ERR.unknown }, 400);
  const s = await getSettings(env);
  if (isGrant(key)) {
    const g = await env.DB.prepare("SELECT * FROM grants WHERE code = ?").bind(key).first();
    if (!g) return json({ error: ERR.unknown }, 404);
    if (g.revoked) return json({ error: ERR.revoked }, 403);
    if (g.until && g.until < Date.now()) return json({ error: ERR.expired }, 403);
    const devices = (await env.DB.prepare("SELECT * FROM grant_devices WHERE code = ?").bind(key).all()).results;
    let inst = devices.find((d) => d.device === device);
    if (!inst) {
      if (devices.length >= g.max_devices) return json({ error: ERR.limit }, 409);
      inst = { instance: crypto.randomUUID(), device };
      await env.DB.prepare("INSERT INTO grant_devices (code, instance, device, name, created) VALUES (?, ?, ?, ?, ?)").bind(key, inst.instance, device, name, Date.now()).run();
    }
    return json({ token: await token(env, { lic: "g:" + key, inst: inst.instance, dev: device, plan: g.plan, until: g.until || null, f: FEATURES }), instance: inst.instance, plan: g.plan });
  }
  // a Lemon Squeezy key (UUID)
  const lsKey = key.toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(lsKey)) return json({ error: ERR.unknown }, 400);
  const r = await ls(env, "activate", { license_key: lsKey, instance_name: (name || "PDF Editor") + " · " + device.slice(0, 8) });
  if (!r || (!r.activated && !r.error)) return json({ error: ERR.busy }, 502);
  if (!r.activated) return json({ error: /activation limit/i.test(r.error) ? ERR.limit : /expired/i.test(r.error) ? ERR.expired : /disabled/i.test(r.error) ? ERR.revoked : ERR.unknown }, /activation limit/i.test(r.error) ? 409 : 403);
  if (!ourStore(s, r.meta)) {                                    // a key from another shop: give the activation back
    await ls(env, "deactivate", { license_key: lsKey, instance_id: r.instance.id });
    return json({ error: ERR.unknown }, 403);
  }
  const plan = planOf(s, r.meta || {});
  return json({ token: await token(env, { lic: "ls:" + r.license_key.id, inst: r.instance.id, dev: device, plan, until: lsUntil(r.license_key), f: FEATURES }), instance: r.instance.id, plan });
}

async function refresh(env, b) {
  const key = clean(b.key, 80).toUpperCase().replace(/\s+/g, ""), instance = clean(b.instance, 64), device = clean(b.device, 64);
  if (!key || !instance || !/^[a-f0-9]{32}$/.test(device)) return json({ error: ERR.unknown, gone: true }, 400);
  const s = await getSettings(env);
  if (isGrant(key)) {
    const g = await env.DB.prepare("SELECT * FROM grants WHERE code = ?").bind(key).first();
    const d = g && await env.DB.prepare("SELECT * FROM grant_devices WHERE code = ? AND instance = ?").bind(key, instance).first();
    if (!g || !d || d.device !== device) return json({ error: ERR.unknown, gone: true }, 404);
    if (g.revoked) return json({ error: ERR.revoked, gone: true }, 403);
    if (g.until && g.until < Date.now()) return json({ error: ERR.expired, gone: true }, 403);
    return json({ token: await token(env, { lic: "g:" + key, inst: instance, dev: device, plan: g.plan, until: g.until || null, f: FEATURES }), plan: g.plan });
  }
  const r = await ls(env, "validate", { license_key: key.toLowerCase(), instance_id: instance });
  if (!r || (r.valid === undefined && !r.error)) return json({ error: ERR.busy }, 502);
  const st = r.license_key && r.license_key.status;
  if (!r.valid || !r.instance || st === "expired" || st === "disabled" || !ourStore(s, r.meta))
    return json({ error: st === "expired" ? ERR.expired : st === "disabled" ? ERR.revoked : ERR.unknown, gone: true }, 403);
  const plan = planOf(s, r.meta || {});
  return json({ token: await token(env, { lic: "ls:" + r.license_key.id, inst: instance, dev: device, plan, until: lsUntil(r.license_key), f: FEATURES }), plan });
}

async function release(env, b) {
  const key = clean(b.key, 80).toUpperCase().replace(/\s+/g, ""), instance = clean(b.instance, 64);
  if (!key || !instance) return json({ ok: false }, 400);
  if (isGrant(key)) {
    await env.DB.prepare("DELETE FROM grant_devices WHERE code = ? AND instance = ?").bind(key, instance).run();
    return json({ ok: true });
  }
  const r = await ls(env, "deactivate", { license_key: key.toLowerCase(), instance_id: instance });
  return json({ ok: !!(r && r.deactivated) || /not found|inactive/i.test((r && r.error) || "") });
}

export async function handlePro(request, env, path) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response(null, { status: 403 });         // this site's pages only
  if (path === "/api/pro/config" && request.method === "GET") {
    const r = json(await publicConfig(env));
    r.headers.set("Cache-Control", "public, max-age=60");
    return r;
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!origin) return new Response(null, { status: 403 });                                  // browsers always send it on POST
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
  if (!b || typeof b !== "object" || JSON.stringify(b).length > 1000) return json({ error: "bad request" }, 400);
  if (path === "/api/pro/activate") return activate(env, b);
  if (path === "/api/pro/refresh") return refresh(env, b);
  if (path === "/api/pro/release") return release(env, b);
  return new Response(null, { status: 404 });
}
