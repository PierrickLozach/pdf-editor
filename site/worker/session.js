// PDF Editor - sign-in for the publisher's private pages (/api/admin, /api/stats) without leaving the key in URLs.
// Opening the page once with ?key=… checks the key, sets a session cookie and redirects to the same page without
// the key, so it is not kept in the browser's history, bookmarks, screenshots or the address bar.
// The cookie holds an expiry and an HMAC-SHA-256 of it made with the key itself: changing the key (wrangler secret
// put) signs everyone out. HttpOnly (no script can read it), SameSite=Strict, Secure, __Host- prefix, 12 hours.

const HOURS = 12;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Constant-time comparison of two strings. */
export function same(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sign(secret, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}

const cookieName = (scope, url) => (url.protocol === "https:" ? "__Host-" : "") + "pdfe_" + scope;

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return "";
}

/** Is this request signed in to `scope` (a valid, unexpired session cookie made with `secret`)? */
export async function hasSession(request, scope, secret) {
  if (!secret || secret.length < 16) return false;
  const url = new URL(request.url);
  const v = readCookie(request, cookieName(scope, url));
  const [exp, mac] = v.split(".");
  if (!/^\d{10}$/.test(exp || "") || Number(exp) * 1000 < Date.now()) return false;
  return same(mac, await sign(secret, scope + ":" + exp));
}

/** The response that signs the browser in: a redirect to the same page without ?key=, with the session cookie. */
export async function signIn(request, scope, secret) {
  const url = new URL(request.url);
  url.searchParams.delete("key");
  const exp = String(Math.floor(Date.now() / 1000) + HOURS * 3600);
  const value = exp + "." + await sign(secret, scope + ":" + exp);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, { status: 303, headers: {
    Location: url.pathname + url.search,
    "Set-Cookie": `${cookieName(scope, url)}=${value}; Path=/; Max-Age=${HOURS * 3600}; HttpOnly; SameSite=Strict${secure}`,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex",
  } });
}

/** The response that signs out (the "Sign out" link). */
export function signOut(request, scope) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, { status: 303, headers: {
    Location: "/", "Set-Cookie": `${cookieName(scope, url)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`, "Cache-Control": "no-store",
  } });
}
