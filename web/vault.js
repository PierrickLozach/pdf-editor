/* PDF Editor - accounts with passkeys, and "My PDFs" stored encrypted in this browser.
 *
 * No password, no server, no database:
 *  - creating an account creates a passkey on the device (Touch ID, Face ID, Windows Hello,
 *    a phone or a security key). Passkeys synced by iCloud Keychain / Google Password Manager
 *    also work on the person's other devices of the same ecosystem.
 *  - the passkey's PRF extension gives a 32-byte secret, the same at every sign-in, that only
 *    the passkey can produce. It wraps (AES-KW) a random 256-bit key that encrypts (AES-GCM)
 *    every PDF and its name. Without the passkey, nothing stored can be read.
 *  - everything lives in this browser's IndexedDB ("pdf-editor-vault"): accounts, encrypted
 *    files and their previous versions.
 * Browsers without the PRF extension cannot use accounts; the editor itself still works.
 * Exposes window.Vault. Classic script, loaded before app.js. */
(function () {
  "use strict";
  const DB = "pdf-editor-vault", VER = 1, KEEP_VERSIONS = 5, SESSION = "pdfe.vaultSession";
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u) => { let s = ""; const a = new Uint8Array(u); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64 = (s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); const b = atob(t + "===".slice((t.length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const t = (s) => (window.I18N ? I18N.t(s) : s);

  /* ---------------------------------------------------------------- storage */
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("accounts")) d.createObjectStore("accounts", { keyPath: "id" });
        if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" }).createIndex("account", "account");
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const x = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(...[].concat(stores).map((s) => x.objectStore(s)))).then((v) => (out = v), rej);
      x.oncomplete = () => res(out);
      x.onerror = () => rej(x.error);
      x.onabort = () => rej(x.error || new Error("storage aborted"));
    });
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  /* ---------------------------------------------------------------- crypto */
  async function wrappingKey(prf, salt) {
    const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("pdf-editor vault v1") }, base, { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
  }
  async function seal(key, bytes, aad) {
    const iv = rand(12);
    const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, bytes);
    return { iv, data: new Uint8Array(c) };
  }
  async function open(key, box, aad) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv, additionalData: aad }, key, box.data));
  }
  const aadOf = (accountId, fileId, what) => enc.encode(`${accountId}|${fileId}|${what}`);

  /* ---------------------------------------------------------------- passkeys */
  const PRF_SALT = enc.encode("pdf-editor/vault/prf/v1".padEnd(32, "\0"));
  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext && crypto.subtle);
  }
  async function prfSupported() {
    if (!supported()) return false;
    try {
      if (PublicKeyCredential.getClientCapabilities) {
        const c = await PublicKeyCredential.getClientCapabilities();
        if (c && c["extension:prf"] === false) return false;
      }
    } catch (e) {}
    return true;
  }
  function explain(e) {
    if (!e) return t("Something went wrong. Please try again.");
    if (e.name === "NotAllowedError" || e.name === "AbortError") return t("Cancelled.");
    if (e.name === "InvalidStateError") return t("This device already has a passkey for this site. Sign in instead.");
    if (e.name === "SecurityError") return t("Passkeys need a secure address (https).");
    if (e.name === "NotSupportedError") return t("This browser or device cannot create passkeys.");
    return e.message || String(e);
  }

  async function prfFrom(cred) {
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    const r = ext.prf && ext.prf.results && ext.prf.results.first;
    return r ? new Uint8Array(r) : null;
  }

  /** Sign in with a passkey of this site (any account): returns the PRF secret and the user id. */
  async function assert(allow) {
    const challenge = rand(32);
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge, userVerification: "required", timeout: 120000,
        allowCredentials: allow ? allow.map((id) => ({ type: "public-key", id: unb64(id) })) : [],
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    return { cred, challenge, credId: cred.id, user: cred.response.userHandle ? b64(cred.response.userHandle) : null, prf: await prfFrom(cred) };
  }

  /* ---------------------------------------------------------------- passkeys without PRF
   * Some passkey providers (for example some password-manager extensions) cannot give the PRF
   * secret. Their accounts use a "device" key instead: a random AES-256 key that the browser keeps
   * as a non-exportable key (it can encrypt and decrypt, but its value can never be read). The
   * files only open after a passkey sign-in whose signature is checked here, against the public
   * key saved when the passkey was created. */
  function derToRaw(der, size) {             // ECDSA signature: DER SEQUENCE{r, s} -> r || s
    let i = 2;
    if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
    const part = () => {
      if (der[i++] !== 2) throw new Error("bad signature");
      const len = der[i++];
      let v = der.slice(i, i + len); i += len;
      while (v.length > size && v[0] === 0) v = v.slice(1);
      const out = new Uint8Array(size); out.set(v, size - v.length); return out;
    };
    const r = part(), sg = part(), o = new Uint8Array(size * 2);
    o.set(r); o.set(sg, size);
    return o;
  }
  const ALGS = {
    "-7": { imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" }, der: 32 },
    "-257": { imp: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, ver: { name: "RSASSA-PKCS1-v1_5" } },
    "-8": { imp: { name: "Ed25519" }, ver: { name: "Ed25519" } },
  };
  async function verifyAssertion(account, cred, challenge) {
    const k = (account.keys || {})[cred.id];
    if (!k) return account.credIds.includes(cred.id);      // the browser gave no public key: trust the browser
    const a = ALGS[String(k.alg)];
    if (!a) return account.credIds.includes(cred.id);
    const r = cred.response;
    const cd = JSON.parse(dec.decode(r.clientDataJSON));
    if (cd.type !== "webauthn.get" || cd.origin !== location.origin || cd.challenge !== b64(challenge)) return false;
    const ad = new Uint8Array(r.authenticatorData);
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(location.hostname)));
    for (let i = 0; i < 32; i++) if (rpHash[i] !== ad[i]) return false;
    if ((ad[32] & 0x05) !== 0x05) return false;            // user present and verified
    const key = await crypto.subtle.importKey("spki", unb64(k.spki), a.imp, false, ["verify"]);
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", r.clientDataJSON));
    const data = new Uint8Array(ad.length + 32); data.set(ad); data.set(h, ad.length);
    let sig = new Uint8Array(r.signature);
    if (a.der) sig = derToRaw(sig, a.der);
    return crypto.subtle.verify(a.ver, key, sig, data);
  }
  async function forget(credId) {             // remove a passkey we will not use from the device's list
    try { if (PublicKeyCredential.signalUnknownCredential) await PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: credId }); } catch (e) {}
  }

  /* ---------------------------------------------------------------- session (this tab) */
  let current = null;            // { account, key }
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(current && current.account); } catch (e) {} });

  async function unlock(account, prf) {
    let key;
    if (account.mode === "device") {
      key = account.deviceKey;
      try { sessionStorage.setItem(SESSION, JSON.stringify({ id: account.id, device: true })); } catch (e) {}
    } else {
      const wk = await wrappingKey(prf, unb64(account.salt));
      key = await crypto.subtle.unwrapKey("raw", unb64(account.wrapped), wk, "AES-KW", { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      try { sessionStorage.setItem(SESSION, JSON.stringify({ id: account.id, k: b64(await crypto.subtle.exportKey("raw", key)) })); } catch (e) {}
    }
    current = { account, key };
    await tx("accounts", "readwrite", (st) => req(st.put({ ...account, lastSignIn: Date.now() })));
    emit();
    return publicAccount(account);
  }
  const publicAccount = (a) => a && { id: a.id, name: a.name, createdAt: a.createdAt, lastSignIn: a.lastSignIn, picture: a.picture || null, mode: a.mode || "prf" };

  /** Restore the session after a reload in the same tab (no second passkey prompt). */
  async function resume() {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(SESSION) || "null"); } catch (e) {}
    if (!s) return null;
    const account = await tx("accounts", "readonly", (st) => req(st.get(s.id)));
    if (!account) { sessionStorage.removeItem(SESSION); return null; }
    const key = s.device ? (account.mode === "device" ? account.deviceKey : null)
      : await crypto.subtle.importKey("raw", unb64(s.k), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    if (!key) { sessionStorage.removeItem(SESSION); return null; }
    current = { account, key };
    emit();
    return publicAccount(account);
  }

  const Vault = {
    supported, prfSupported, explain,
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    get account() { return current ? publicAccount(current.account) : null; },
    async accounts() { return (await tx("accounts", "readonly", (st) => req(st.getAll()))).map(publicAccount); },

    /** Create an account: one passkey, one encryption key. */
    async create(name) {
      name = String(name || "").trim().slice(0, 60);
      if (!name) throw new Error(t("Please enter your name."));
      const userId = rand(16);
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: (window.I18N ? I18N.t("PDF Editor") : "PDF Editor") },
          user: { id: userId, name, displayName: name },
          challenge: rand(32),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }, { type: "public-key", alg: -8 }],
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
          timeout: 120000,
          extensions: { prf: { eval: { first: PRF_SALT } }, credProps: true },
        },
      });
      try {
        const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
        let prf = await prfFrom(cred);
        if (!prf && ext.prf && ext.prf.enabled) prf = (await assert([cred.id])).prf;   // some give it only at sign-in
        const r = cred.response, keys = {};
        try {
          const spki = r.getPublicKey && r.getPublicKey(), alg = r.getPublicKeyAlgorithm && r.getPublicKeyAlgorithm();
          if (spki && alg) keys[cred.id] = { alg, spki: b64(spki) };
        } catch (e) {}
        const account = { id: b64(userId), name, credIds: [cred.id], keys, createdAt: Date.now(), lastSignIn: Date.now() };
        if (prf) {
          const salt = rand(32);
          const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
          const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", key, await wrappingKey(prf, salt), "AES-KW"));
          Object.assign(account, { mode: "prf", salt: b64(salt), wrapped: b64(wrapped) });
        } else {
          const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
          Object.assign(account, { mode: "device", deviceKey });
        }
        await tx("accounts", "readwrite", (st) => req(st.add(account)));
        return await unlock(account, prf);
      } catch (e) {
        await forget(cred.id);                // do not leave an unused passkey behind
        throw e;
      }
    },

    /** Sign in: the browser shows this site's passkeys; the one chosen says which account it is. */
    async signIn() {
      if (!supported()) throw new Error(t("This browser cannot use passkeys."));
      const all = await tx("accounts", "readonly", (st) => req(st.getAll()));
      if (!all.length) throw new Error(t("No account on this browser yet. Create one: it takes a few seconds."));
      const a = await assert(all.flatMap((x) => x.credIds));
      const account = all.find((x) => x.id === a.user) || all.find((x) => x.credIds.includes(a.credId));
      if (!account) throw new Error(t("This passkey's account is not on this browser. Your files are kept in the browser where you created the account."));
      if (account.mode === "device") {
        if (!(await verifyAssertion(account, a.cred, a.challenge))) throw new Error(t("This passkey could not be verified."));
        return unlock(account, null);
      }
      if (!a.prf) throw new Error(t("This passkey cannot unlock your files on this device."));
      try { return await unlock(account, a.prf); }
      catch (e) { throw new Error(t("This passkey cannot unlock your files on this device.")); }
    },

    resume,
    signOut() {
      current = null;
      try { sessionStorage.removeItem(SESSION); } catch (e) {}
      emit();
    },

    /** Delete the account and every file in it (asks the passkey first). */
    async deleteAccount() {
      if (!current) return;
      const id = current.account.id;
      const a = await assert(current.account.credIds);   // confirm it is really the owner
      if (current.account.mode === "device" && !(await verifyAssertion(current.account, a.cred, a.challenge))) throw new Error(t("This passkey could not be verified."));
      const files = await tx("files", "readonly", (st) => req(st.index("account").getAll(id)));
      await tx(["files", "blobs", "accounts"], "readwrite", (fs, bs, as) => {
        for (const f of files) { fs.delete(f.id); for (const v of f.versions) bs.delete(v.blob); }
        as.delete(id);
      });
      try {
        if (PublicKeyCredential.signalUnknownCredential) {
          for (const cid of current.account.credIds) await PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: cid });
        }
      } catch (e) { /* not supported: the passkey stays in the password manager, unused */ }
      Vault.signOut();
      return files.length;
    },

    /* ------------------------------------------------------------ my PDFs */
    async list() {
      if (!current) return [];
      const { account, key } = current;
      const files = await tx("files", "readonly", (st) => req(st.index("account").getAll(account.id)));
      const out = [];
      for (const f of files) {
        let name = "?";
        try { name = dec.decode(await open(key, { iv: unb64(f.nameIv), data: unb64(f.name) }, aadOf(account.id, f.id, "name"))); } catch (e) {}
        out.push({ id: f.id, name, size: f.versions[0].size, updated: f.versions[0].time, created: f.created, versions: f.versions.map((v) => ({ time: v.time, size: v.size })) });
      }
      return out.sort((a, b) => b.updated - a.updated);
    },

    /** Add a new PDF, or save a new version of an existing one (the previous ones are kept). */
    async save(bytes, name, fileId) {
      if (!current) throw new Error(t("Please sign in first."));
      const { account, key } = current;
      const id = fileId || b64(rand(12));
      const blob = b64(rand(12));
      const box = await seal(key, bytes, aadOf(account.id, id, blob));
      const nm = await seal(key, enc.encode(name), aadOf(account.id, id, "name"));
      const v = { blob, iv: b64(box.iv), size: bytes.length, time: Date.now() };
      let dropped = [];
      await tx(["files", "blobs"], "readwrite", async (fs, bs) => {
        const old = fileId ? await req(fs.get(id)) : null;
        if (fileId && (!old || old.account !== account.id)) throw new Error(t("This file is no longer in your account."));
        const versions = [v, ...(old ? old.versions : [])];
        dropped = versions.slice(KEEP_VERSIONS);
        for (const d of dropped) bs.delete(d.blob);
        bs.put(box.data, blob);
        fs.put({ id, account: account.id, name: b64(nm.data), nameIv: b64(nm.iv), created: old ? old.created : Date.now(), versions: versions.slice(0, KEEP_VERSIONS) });
      });
      return { id, name, time: v.time, size: bytes.length };
    },

    /** The latest version of a file (or an older one: version index 1, 2...). */
    async load(fileId, version = 0) {
      if (!current) throw new Error(t("Please sign in first."));
      const { account, key } = current;
      const f = await tx("files", "readonly", (st) => req(st.get(fileId)));
      if (!f || f.account !== account.id) throw new Error(t("This file is no longer in your account."));
      const v = f.versions[version];
      const data = await tx("blobs", "readonly", (st) => req(st.get(v.blob)));
      const bytes = await open(key, { iv: unb64(v.iv), data: new Uint8Array(data) }, aadOf(account.id, fileId, v.blob));
      const name = dec.decode(await open(key, { iv: unb64(f.nameIv), data: unb64(f.name) }, aadOf(account.id, fileId, "name")));
      return { id: fileId, name, bytes, time: v.time };
    },

    async renameFile(fileId, name) {
      if (!current) return;
      const { account, key } = current;
      const nm = await seal(key, enc.encode(String(name).slice(0, 200)), aadOf(account.id, fileId, "name"));
      await tx("files", "readwrite", async (fs) => {
        const f = await req(fs.get(fileId));
        if (!f || f.account !== account.id) return;
        fs.put({ ...f, name: b64(nm.data), nameIv: b64(nm.iv) });
      });
    },

    async remove(fileId) {
      if (!current) return;
      await tx(["files", "blobs"], "readwrite", async (fs, bs) => {
        const f = await req(fs.get(fileId));
        if (!f || f.account !== current.account.id) return;
        for (const v of f.versions) bs.delete(v.blob);
        fs.delete(fileId);
      });
    },

    async usage() {
      try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch (e) { return null; }
    },
    async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } },
  };
  Vault.renameAccount = async (name) => {
    name = String(name || "").trim().slice(0, 60);
    if (!current || !name) return;
    const a = { ...current.account, name };
    await tx("accounts", "readwrite", (st) => req(st.put(a)));
    current.account = a; emit();
  };
  window.Vault = Vault;
})();
