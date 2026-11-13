// A fake Lemon Squeezy (licence API + discounts) for the local tests: http://127.0.0.1:8798
// Keys: one per plan, activation limit 1, store 4242. Another store's key is "foreign".
// Run: node mock-ls.mjs   (the tests start it themselves)
import http from "node:http";
export const KEYS = {
  monthly: "11111111-1111-4111-8111-111111111111",
  yearly: "22222222-2222-4222-8222-222222222222",
  lifetime: "33333333-3333-4333-8333-333333333333",
  expired: "44444444-4444-4444-8444-444444444444",
  foreign: "55555555-5555-4555-8555-555555555555",
};
const VARIANT = { monthly: 901, yearly: 902, lifetime: 903, expired: 901, foreign: 999 };
export function startMock(port = 8798) {
  const lic = new Map(Object.entries(KEYS).map(([plan, key], i) => [key, {
    id: 100 + i, key, plan, status: plan === "expired" ? "expired" : "active", limit: 1, instances: new Map(),
    store: plan === "foreign" ? 7777 : 4242, variant: VARIANT[plan], expires: plan === "monthly" ? new Date(Date.now() + 30 * 86400000).toISOString() : null,
  }]));
  const discounts = [];
  const view = (l) => ({ id: l.id, status: l.status, key: l.key, activation_limit: l.limit, activation_usage: l.instances.size, created_at: "2026-01-01T00:00:00Z", expires_at: l.expires });
  const meta = (l) => ({ store_id: l.store, order_id: 1, product_id: 5, product_name: "PDF Editor Pro", variant_id: l.variant, variant_name: l.plan, customer_id: 9, customer_name: "Test", customer_email: "test@example.com" });
  const srv = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const send = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/discounts" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer test-key") return send({ errors: [{ detail: "Unauthenticated." }] }, 401);
      const d = JSON.parse(body).data.attributes; discounts.push(d);
      return send({ data: { type: "discounts", id: String(discounts.length), attributes: d } }, 201);
    }
    if (req.url === "/_discounts") return send(discounts);
    const p = Object.fromEntries(new URLSearchParams(body));
    const l = lic.get(p.license_key);
    if (req.url === "/v1/licenses/activate") {
      if (!l) return send({ activated: false, error: "license_key not found.", license_key: null, instance: null, meta: null }, 404);
      if (l.status === "expired") return send({ activated: false, error: "This license key is expired.", license_key: view(l), instance: null, meta: meta(l) }, 400);
      if (l.instances.size >= l.limit) return send({ activated: false, error: "This license key has reached the activation limit.", license_key: view(l), instance: null, meta: meta(l) }, 400);
      const inst = { id: crypto.randomUUID(), name: p.instance_name, created_at: new Date().toISOString() };
      l.instances.set(inst.id, inst);
      return send({ activated: true, error: null, license_key: view(l), instance: inst, meta: meta(l) });
    }
    if (req.url === "/v1/licenses/validate") {
      if (!l) return send({ valid: false, error: "license_key not found.", license_key: null, instance: null, meta: null }, 404);
      const inst = l.instances.get(p.instance_id);
      if (!inst) return send({ valid: false, error: "license_key instance not found.", license_key: view(l), instance: null, meta: meta(l) }, 404);
      return send({ valid: l.status === "active", error: null, license_key: view(l), instance: inst, meta: meta(l) });
    }
    if (req.url === "/v1/licenses/deactivate") {
      if (!l || !l.instances.has(p.instance_id)) return send({ deactivated: false, error: "license_key instance not found.", license_key: l ? view(l) : null, meta: null }, 404);
      l.instances.delete(p.instance_id);
      return send({ deactivated: true, error: null, license_key: view(l), meta: meta(l) });
    }
    if (req.url === "/_expire" && l) { l.status = "expired"; return send({ ok: true }); }
    if (req.url === "/_reset") { for (const x of lic.values()) { x.instances.clear(); x.status = x.plan === "expired" ? "expired" : "active"; } discounts.length = 0; return send({ ok: true }); }
    send({ error: "not found" }, 404);
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
if (import.meta.url === `file://${process.argv[1]}`) startMock().then(() => console.log("fake Lemon Squeezy on http://127.0.0.1:8798"));
