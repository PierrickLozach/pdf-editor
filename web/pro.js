/* PDF Editor - Pro licence in the browser (uses the globals of app.js / tools.js).
 * A licence is checked on this site's server, which returns a token signed with its private key; this
 * file only holds the public key, so the token cannot be made here. The token is bound to this
 * browser's random identifier (localStorage pdfe.device) and renewed every few days.
 * PRO.has(feature) · await PRO.require(feature) (shows the Pro window when needed) · PRO.open() */
(function () {
  "use strict";
  const PUBLIC_KEY = { kty: "EC", crv: "P-256", x: "zXN0Mol-fcOAzGYnQZaGoaBc6lldT-Wju8S4_LGAdA4", y: "5rEIlXSqWunLd8618pgq7w-ZwTeYVTWND-mSA9qZM0Y" };
  const K_DEV = "pdfe.device", K_LIC = "pdfe.pro";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstElementChild; };
  const P = (window.PRO = { state: null, config: null });
  const FEATURE = {
    batch: ["Batch processing", "Merge, compress, number, watermark, find & replace or protect many PDFs at once"],
    smartredact: ["Smart redaction", "Find and black out emails, phone numbers, IBANs, card and social security numbers"],
    ocr: ["Unlimited text recognition", "Make scans searchable without a page limit"],
    compare: ["Compare two PDFs", "See what changed between two versions"],
    forms: ["Forms", "Fill in PDF forms and add your own fields"],
  };

  /* ---------------------------------------------------------------- this browser */
  function deviceId() {
    let d = null;
    try { d = localStorage.getItem(K_DEV); } catch (e) {}
    if (!/^[a-f0-9]{32}$/.test(d || "")) {
      d = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem(K_DEV, d); } catch (e) {}
    }
    return d;
  }
  function deviceName() {
    const ua = navigator.userAgent;
    const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const o = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return b + (o ? " · " + o : "");
  }
  const load = () => { try { return JSON.parse(localStorage.getItem(K_LIC) || "null"); } catch (e) { return null; } };
  const store = (v) => { try { v ? localStorage.setItem(K_LIC, JSON.stringify(v)) : localStorage.removeItem(K_LIC); } catch (e) {} };

  /* ---------------------------------------------------------------- the signed token */
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  let verifyKey = null;
  async function verify(token) {
    try {
      const [body, sig] = String(token || "").split(".");
      if (!body || !sig) return null;
      verifyKey = verifyKey || await crypto.subtle.importKey("jwk", PUBLIC_KEY, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, unb64(sig), new TextEncoder().encode(body)))) return null;
      const c = JSON.parse(new TextDecoder().decode(unb64(body)));
      if (c.v !== 1 || c.dev !== deviceId() || !(c.exp > Date.now()) || (c.until && c.until < Date.now())) return null;
      return c;
    } catch (e) { return null; }
  }
  async function api(path, body) {
    const r = await fetch("/api/pro/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit" });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    return j;
  }

  /** The licence of this browser, checked again when its token is getting old. */
  P.ready = (async () => {
    const lic = load();
    if (!lic) return null;
    let c = await verify(lic.token);
    const old = !c || c.exp - Date.now() < 5 * 86400000;
    if (old) {
      try {
        const r = await api("refresh", { key: lic.key, instance: lic.instance, device: deviceId() });
        if (r.token) { lic.token = r.token; store(lic); c = await verify(r.token); }
        else if (r.gone) { store(null); c = null; setTimeout(() => toast(t(r.error || "This licence has ended.") + " " + t("Pro is switched off on this computer."), true, 9000), 1500); }
      } catch (e) { /* offline: the token keeps working until it expires */ }
    }
    P.state = c ? { plan: c.plan, until: c.until, feats: c.f || [] } : null;
    document.documentElement.classList.toggle("is-pro", !!P.state);
    return P.state;
  })();
  P.has = (f) => !!(P.state && (P.state.feats || []).includes(f));
  P.require = async (f) => {
    await P.ready;
    if (P.has(f)) return true;
    window.PDFE_STATS && PDFE_STATS.event("pro_shown", { tool: f });
    return P.open(f);
  };
  P.getConfig = async () => {
    if (P.config) return P.config;
    try { const r = await fetch("/api/pro/config", { credentials: "omit" }); if (r.ok) P.config = await r.json(); } catch (e) {}
    return P.config || { sales: false, plans: [], currency: "EUR", freeOcrPages: 3 };
  };

  /* ---------------------------------------------------------------- the Pro window */
  const money = (n, cur) => { try { return new Intl.NumberFormat((window.I18N && I18N.lang) || "en", { style: "currency", currency: cur, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch (e) { return n + " " + cur; } };
  const PLAN = { monthly: ["Monthly", "per month"], yearly: ["Yearly", "per year"], lifetime: ["Lifetime", "once – at least 2 years"] };
  const legal = () => { const l = (window.I18N && I18N.lang) || "en"; return (l === "en" ? "/" : `/${l}/`); };

  /** Resolves true when Pro is active when the window closes. */
  P.open = (feature) => new Promise(async (resolve) => {
    await P.ready;
    const old = document.getElementById("proDlg"); if (old) old.remove();
    const cfg = await P.getConfig(), lic = load(), on = !!P.state;
    const feats = Object.entries(FEATURE).map(([k, [h, sub]]) => `<li class="${k === feature ? "hl" : ""}"><b>${esc(t(h))}</b><span>${esc(t(sub))}</span></li>`).join("");
    const plans = cfg.plans.map((p) => `<div class="pro-plan"><b>${esc(t(PLAN[p.id][0]))}</b><span class="price">${esc(money(p.price, cfg.currency))}</span><small>${esc(t(PLAN[p.id][1]))}</small>
      ${p.checkout ? `<a class="btn primary" href="${esc(p.checkout)}" target="_blank" rel="noopener">${esc(t("Buy"))}</a>` : ""}</div>`).join("");
    const until = on && P.state.until ? new Date(P.state.until).toLocaleDateString((window.I18N && I18N.lang) || "en", { dateStyle: "long" }) : "";
    const d = el(`<div id="proDlg" class="dlg pro-dlg" role="dialog" aria-modal="true" aria-labelledby="proDlgT"><div class="box">
      <div class="dlg-head"><h2 id="proDlgT"><span class="pro-badge">PRO</span> ${esc(t("PDF Editor Pro"))}</h2><button class="icon close" title="${esc(t("Close (Esc)"))}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      ${feature && !on ? `<p class="pro-why">${esc(t("“{f}” is part of Pro.").replace("{f}", t(FEATURE[feature][0])))}</p>` : ""}
      ${on ? `<p class="pro-on">✓ ${esc(t("Pro is active on this computer."))} ${esc(t(PLAN[P.state.plan] ? PLAN[P.state.plan][0] : P.state.plan))}${until ? " · " + esc(t("until {d}").replace("{d}", until)) : ""}</p>` : ""}
      <ul class="pro-feats">${feats}</ul>
      ${on ? "" : (cfg.sales && cfg.plans.length ? `<div class="pro-plans">${plans}</div><p class="small muted">${esc(t("Prices include taxes. After paying you receive your licence key by email: enter it below. One licence works on one computer at a time."))}</p>`
        : `<p class="pro-soon">${esc(t("Pro is not on sale yet. If you were given a licence key, enter it below."))}</p>`)}
      ${on ? `<div class="actions"><button class="pro-release">${esc(t("Release this computer"))}</button><button class="primary pro-close">${esc(t("Close"))}</button></div>
        <p class="small muted">${esc(t("Releasing this computer lets you use your licence on another one."))}</p>`
      : `<label class="field">${esc(t("Licence key"))} <input class="pro-key" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(t("e.g. PDFE-ABCD-EFGH-JKLM"))}" value="${esc(lic ? lic.key : "")}"></label>
        <p class="err warnbox" role="alert" hidden></p>
        <div class="actions"><button class="pro-close">${esc(t("Not now"))}</button><button class="primary pro-activate">${esc(t("Activate"))}</button></div>`}
      <p class="small muted foot"><a href="${legal()}sales" target="_blank" rel="noopener">${esc(t("Terms of sale"))}</a> · ${esc(t("Everyday editing stays free, without an account."))}</p>
    </div></div>`);
    document.body.appendChild(d);
    const done = (v) => { d.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(!!P.state); } };
    document.addEventListener("keydown", onKey, true);
    d.querySelector(".close").onclick = () => done(!!P.state);
    d.querySelectorAll(".pro-close").forEach((b) => (b.onclick = () => done(!!P.state)));
    d.addEventListener("pointerdown", (e) => { if (e.target === d) done(!!P.state); });
    const err = d.querySelector(".err"), input = d.querySelector(".pro-key");
    if (input) setTimeout(() => input.focus(), 30);
    const act = d.querySelector(".pro-activate");
    const activate = async () => {
      const key = input.value.trim();
      if (!key) { err.textContent = t("Enter your licence key."); err.hidden = false; return; }
      act.disabled = true; err.hidden = true;
      try {
        const r = await api("activate", { key, device: deviceId(), name: deviceName() });
        const c = r.token && await verify(r.token);
        if (!c) throw new Error(r.error || "The licence could not be checked just now. Try again in a moment.");
        store({ key, instance: r.instance, token: r.token });
        P.state = { plan: c.plan, until: c.until, feats: c.f || [] };
        document.documentElement.classList.add("is-pro");
        window.PDFE_STATS && PDFE_STATS.event("pro_activated");
        toast(t("Pro is active on this computer. Thank you!"), false, 6000);
        done(true);
      } catch (e) { err.textContent = t(e.message); err.hidden = false; act.disabled = false; }
    };
    if (act) { act.onclick = activate; input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); activate(); } }); }
    const rel = d.querySelector(".pro-release");
    if (rel) rel.onclick = async () => {
      d.hidden = true;                                   // the confirmation opens over the page, not behind this window
      if (!(await modal({ title: t("Release this computer?"), text: t("Pro stops on this computer and your licence can be activated on another one."), ok: t("Release") }))) { d.hidden = false; return; }
      const l = load();
      try { if (l) await api("release", { key: l.key, instance: l.instance }); } catch (e) {}
      store(null); P.state = null; document.documentElement.classList.remove("is-pro");
      toast(t("This computer is released: you can activate your licence on another one."), false, 7000);
      done(false);
    };
  });
})();
