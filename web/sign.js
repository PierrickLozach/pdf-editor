/* PDF Editor - Sign (uses the globals of app.js, tools.js and place.js).
 *  Draw it (mouse, finger or pen), type it (handwriting font), or upload a picture of it.
 *  Its background is made transparent; it is kept in this browser (not uploaded) to sign again
 *  in one click. Then it is placed, moved and resized like an image, and added once. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const esc = (s) => (window.TOOLS ? TOOLS.esc(s) : String(s));
  const KEY = "pdfe.signatures", MAX = 6;
  const SIGN = (window.SIGN = {});
  const INKS = { "#111827": "Black", "#1d4ed8": "Blue" };

  /* ---------------------------------------------------------------- saved signatures (this browser only) */
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]").filter((s) => /^data:image\/png;base64,/.test(s.png)); } catch (e) { return []; } };
  const keep = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (e) {} };

  /** A canvas cropped to its ink, with a little margin, as PNG bytes (transparent background). */
  function cropped(c) {
    const ctx = c.getContext("2d"), { width: w, height: h } = c, d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    const o = document.createElement("canvas");
    o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext("2d").drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    return o;
  }
  /** A photo or scan of a signature: the paper becomes transparent, the ink stays. */
  async function fromPicture(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    // paper brightness: the 90th percentile of the picture's lightness
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0]++;
    let acc = 0, paper = 255; const total = d.length / 4;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.9) { paper = v; break; } }
    const lo = paper * 0.55, hi = paper * 0.85;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      const a = l <= lo ? 255 : l >= hi ? 0 : Math.round(255 * (hi - l) / (hi - lo));
      d[i + 3] = Math.min(d[i + 3], a);
    }
    ctx.putImageData(img, 0, 0);
    return cropped(c);
  }
  /** A typed name in the handwriting font. */
  async function typed(name, ink) {
    if (!SIGN.font) {
      const f = new FontFace("PDFE Signature", `url(${new URL("vendor/fonts-sign/dancing-script-latin-500-normal.ttf", location.href)}), url(${new URL("vendor/fonts-sign/dancing-script-latin-ext-500-normal.ttf", location.href)})`);
      SIGN.font = f.load().then((ff) => { document.fonts.add(ff); return true; }).catch(() => false);
    }
    const hand = await SIGN.font;
    const c = document.createElement("canvas"), ctx = c.getContext("2d"), px = 96;
    const font = `500 ${px}px ${hand ? '"PDFE Signature", ' : ""}"Brush Script MT", cursive`;
    ctx.font = font;
    c.width = Math.ceil(ctx.measureText(name).width + px); c.height = Math.ceil(px * 1.7);
    ctx.font = font; ctx.fillStyle = ink; ctx.textBaseline = "middle";
    ctx.fillText(name, px / 2, c.height / 2);
    return cropped(c);
  }
  const bytesOf = (canvas) => new Promise((res) => canvas.toBlob(async (b) => res({ blob: b, bytes: new Uint8Array(await b.arrayBuffer()) }), "image/png"));

  /* ---------------------------------------------------------------- the window */
  SIGN.open = async () => {
    if (!S.doc) return;
    const list = saved();
    const v = await new Promise((resolve) => {
      const body = `
        ${list.length ? `<div class="sig-saved"><p class="small muted">${esc(t("Your signatures (kept in this browser):"))}</p><div class="sig-list">${list.map((s, i) => `<span class="sig-item"><button class="sig-use" data-i="${i}" title="${esc(t("Use this signature"))}"><img alt="" src="${s.png}"></button><button class="sig-del icon" data-i="${i}" title="${esc(t("Forget this signature"))}">✕</button></span>`).join("")}</div></div>` : ""}
        <div class="sig-tabs" role="tablist"><button role="tab" data-tab="draw" aria-selected="true">${esc(t("Draw"))}</button><button role="tab" data-tab="type">${esc(t("Type"))}</button><button role="tab" data-tab="upload">${esc(t("Upload"))}</button></div>
        <div class="sig-pane" data-pane="draw"><canvas class="sig-pad" width="900" height="300" aria-label="${esc(t("Sign here with the mouse, a finger or a pen"))}"></canvas>
          <p class="small muted sig-hint">${esc(t("Sign here with the mouse, a finger or a pen"))} · <button class="link sig-clear">${esc(t("Clear"))}</button></p></div>
        <div class="sig-pane" data-pane="type" hidden><label class="field">${esc(t("Your name"))} <input class="sig-name" type="text" maxlength="60" autocomplete="name"></label><div class="sig-preview" aria-live="polite"></div></div>
        <div class="sig-pane" data-pane="upload" hidden><p class="small">${esc(t("A photo or scan of your signature on white paper: the paper is made transparent."))}</p><input class="sig-file" type="file" accept="image/*"><div class="sig-preview up"></div></div>
        <div class="sig-ink">${Object.entries(INKS).map(([c, n], i) => `<label class="check"><input type="radio" name="ink" value="${c}"${i ? "" : " checked"}> <span class="sw" data-c="${c}"></span> ${esc(t(n))}</label>`).join("")}
          <label class="check sig-remember"><input type="checkbox" class="sig-keep" checked> <span>${esc(t("Remember it in this browser"))}</span></label></div>`;
      TOOLS.ask("signDlg", t("Sign"), body, t("Place the signature")).then((r) => resolve(r && { ...r, ...SIGN._pick() }));
      const d = TOOLS.open;
      for (const sw of d.querySelectorAll(".sw")) sw.style.background = sw.dataset.c;
      const ink = () => d.querySelector('input[name="ink"]:checked').value;
      let tab = "draw", upload = null, choice = null;
      const show = (k) => { tab = k; for (const b of d.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === k)); for (const p of d.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== k; };
      for (const b of d.querySelectorAll("[data-tab]")) b.onclick = () => show(b.dataset.tab);
      // drawing: smooth strokes, pressure from pens
      const pad = d.querySelector(".sig-pad"), ctx = pad.getContext("2d");
      let drawn = false, last = null;
      const pt = (e) => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * pad.width / r.width, y: (e.clientY - r.top) * pad.height / r.height, p: e.pressure || 0.5 }; };
      pad.addEventListener("pointerdown", (e) => { e.preventDefault(); pad.setPointerCapture(e.pointerId); last = pt(e); drawn = true; ctx.fillStyle = ink(); ctx.beginPath(); ctx.arc(last.x, last.y, 2.2, 0, 7); ctx.fill(); });
      pad.addEventListener("pointermove", (e) => {
        if (!last) return;
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of evs) {
          const p = pt(ev);
          ctx.strokeStyle = ink(); ctx.lineCap = ctx.lineJoin = "round"; ctx.lineWidth = 2.5 + 3.5 * (ev.pointerType === "pen" ? p.p : 0.5);
          ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          last = p;
        }
      });
      const end = () => { last = null; };
      pad.addEventListener("pointerup", end); pad.addEventListener("pointercancel", end);
      d.querySelector(".sig-clear").onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };
      // typing: live preview in the handwriting font
      const nameIn = d.querySelector(".sig-name"), prev = d.querySelector('[data-pane="type"] .sig-preview');
      const refresh = async () => { prev.textContent = ""; const n = nameIn.value.trim(); if (!n) return; const c = await typed(n, ink()); if (c && nameIn.value.trim() === n) { c.className = "sig-canvas"; prev.appendChild(c); } };
      nameIn.addEventListener("input", refresh);
      for (const r of d.querySelectorAll('input[name="ink"]')) r.addEventListener("change", refresh);
      // upload
      const fileIn = d.querySelector(".sig-file"), up = d.querySelector(".sig-preview.up");
      fileIn.onchange = async () => { up.textContent = ""; upload = null; const f = fileIn.files[0]; if (!f) return; try { upload = await fromPicture(f); } catch (e) {} if (upload) { upload.className = "sig-canvas"; up.appendChild(upload); } else up.textContent = t("This picture could not be read."); };
      // saved ones
      for (const b of d.querySelectorAll(".sig-use")) b.onclick = () => { choice = list[+b.dataset.i]; d.querySelector(".td-ok").click(); };
      for (const b of d.querySelectorAll(".sig-del")) b.onclick = () => { list.splice(+b.dataset.i, 1); keep(list); b.closest(".sig-item").remove(); };
      SIGN._pick = () => ({ tab, drawnCanvas: drawn ? cropped(pad) : null, name: nameIn.value.trim(), upload, choice, ink: ink(), keep: d.querySelector(".sig-keep").checked });
    });
    if (!v) return;
    let canvas = null, png = null;
    if (v.choice) png = v.choice.png;
    else if (v.tab === "draw") canvas = v.drawnCanvas;
    else if (v.tab === "type") canvas = v.name ? await typed(v.name, v.ink) : null;
    else canvas = v.upload;
    if (!canvas && !png) return toast(v.tab === "draw" ? t("Draw your signature first") : v.tab === "type" ? t("Type your name first") : t("Choose a picture of your signature first"), true);
    let blob, w, h;
    if (png) { blob = await (await fetch(png)).blob(); const b = await createImageBitmap(blob); w = b.width; h = b.height; b.close(); }
    else {
      ({ blob } = await bytesOf(canvas)); w = canvas.width; h = canvas.height;
      if (v.keep) { const url = canvas.toDataURL("image/png"); if (url.length < 400000) keep([{ png: url, time: Date.now() }, ...saved().filter((s) => s.png !== url)]); }
    }
    // placed like an image: a click (or drag) on the page, then moved and resized, then added once
    S.image = { blob, w, h, name: t("Signature"), signature: true };
    setTool("image");
    toast(t("Click where the signature goes, then adjust it"), false, 6000);
  };
})();
