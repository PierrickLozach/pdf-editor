/* PDF Editor - deleting items (uses the globals of app.js).
 * In Edit text mode, a click on text that cannot be edited in place (a tilted stamp or watermark) or
 * on a picture selects it: a small bar offers "Delete" and, when the same item is on other pages,
 * "Delete on every page". Delete / Backspace deletes, Esc cancels. Normal lines are deleted from the
 * editing bar (the bin button). Everything is one undo step. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const R = (window.REMOVE = { sel: null });
  const BIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

  function bar() {
    let b = document.getElementById("removeBar");
    if (b) return b;
    b = document.createElement("div");
    b.id = "removeBar"; b.className = "remove-bar"; b.hidden = true; b.setAttribute("role", "toolbar");
    b.innerHTML = `<span class="rm-what"></span><span class="rm-hint" hidden></span><button class="primary rm-one">${BIN}<span></span></button><button class="rm-all" hidden></button><button class="icon rm-x" title="${esc(t("Cancel (Esc)"))}">✕</button>`;
    document.body.appendChild(b);
    b.querySelector(".rm-one").onclick = () => R.remove(false);
    b.querySelector(".rm-all").onclick = () => R.remove(true);
    b.querySelector(".rm-x").onclick = () => R.clear();
    return b;
  }

  R.clear = () => {
    if (!R.sel) return;
    for (const el of R.sel.els) el.remove();
    R.sel = null;
    bar().hidden = true;
  };

  function show(page, boxes, what, oneLabel, allCount) {
    const layer = $(".layer", pageEl(page));
    const z = S.zoom, els = [];
    for (const r of boxes) {
      const d = document.createElement("div");
      d.className = "rm-sel";
      Object.assign(d.style, { left: (r[0] - 3) * z + "px", top: (r[1] - 3) * z + "px", width: (r[2] - r[0] + 6) * z + "px", height: (r[3] - r[1] + 6) * z + "px" });
      layer.appendChild(d);
      els.push(d);
    }
    if (R.sel.kind === "image") {                         // corners: resize it (proportions kept)
      const d = els[0];
      d.classList.add("rm-img");
      for (const c of ["nw", "ne", "sw", "se"]) {
        const h = document.createElement("div");
        h.className = "rm-handle " + c; h.dataset.c = c;
        h.title = t("Drag to resize");
        h.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const s = R.sel;
          if (!s) return;
          drag(e, page, s.im, c);
        });
        d.appendChild(h);
      }
    }
    R.sel.els = els;
    const b = bar();
    b.querySelector(".rm-what").textContent = what;
    const hint = b.querySelector(".rm-hint");
    hint.hidden = R.sel.kind !== "image";
    hint.textContent = R.sel.kind === "image" ? t("Drag it to move it, or a corner to resize it") : "";
    b.querySelector(".rm-one span").textContent = oneLabel;
    const all = b.querySelector(".rm-all");
    all.hidden = !allCount;
    all.textContent = allCount ? t("Delete on every page ({n})").replace("{n}", allCount + 1) : "";
    b.hidden = false;
    // a small item: just under it; a big one (a page-wide watermark): at the top of the pages, over nothing
    const u = boxes.reduce((a, r) => [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3])]);
    const pr = pageEl(page).getBoundingClientRect(), vr = document.getElementById("viewer").getBoundingClientRect(), bw = b.offsetWidth, bh = b.offsetHeight;
    let x = pr.left + ((u[0] + u[2]) / 2) * z - bw / 2, y = pr.top + u[3] * z + 12;
    if ((u[3] - u[1]) * z > vr.height * 0.4 || y + bh > innerHeight - 10) { x = vr.left + (vr.width - bw) / 2; y = vr.top + 10; }
    Object.assign(b.style, { left: Math.max(8, Math.min(x, innerWidth - bw - 8)) + "px", top: Math.max(vr.top + 6, y) + "px" });
    b.querySelector(".rm-one").focus({ preventScroll: true });
  }

  /** A click on a line that cannot be edited in place (a stamp, a watermark): select it with its group. */
  let token = 0;                                          // the latest click wins
  R.selectText = async (page, sp) => {
    R.clear();
    const mine = ++token;
    if (S.pending) await S.pending;
    const sim = await call("similarText", page, sp.id);
    if (mine !== token) return;
    const spans = S.spans[S.doc.pages[page].v] || [];
    const boxes = sim.group.map((id) => (spans.find((x) => x.id === id) || sp).tbox);
    R.sel = { kind: "text", page, ids: sim.group, pages: sim.pages, els: [] };
    show(page, boxes, t("Stamp or watermark"), sim.group.length > 1 ? t("Delete ({n} lines)").replace("{n}", sim.group.length) : t("Delete"), sim.pages.length);
  };
  /** A click on a picture. */
  R.selectImage = async (page, im) => {
    R.clear();
    const mine = ++token;
    const others = await call("similarImages", page, im.id);
    if (mine !== token) return;
    R.sel = { kind: "image", page, im, others, els: [] };
    show(page, [im.bbox], t("Picture"), t("Delete"), others.length);
  };
  /** Delete the line being edited (the bin button of the editing bar). */
  R.deleteEditing = async () => {
    const ed = S.ed;
    if (!ed || ed.mode !== "edit") return;
    const { page, span } = ed;
    await closeEditor(false);
    await busy(async () => { applyInfo(await call("removeText", [{ page, ids: [span.id] }])); });
    toast(t("Deleted. You can undo it."));
    if (window.PDFE_STATS) PDFE_STATS.event("tool_used", { tool: "delete" });
  };

  R.remove = async (everywhere) => {
    const s = R.sel;
    if (!s) return;
    R.clear();
    await busy(async () => {
      if (s.kind === "text") {
        const items = [{ page: s.page, ids: s.ids }, ...(everywhere ? s.pages : [])];
        applyInfo(await call("removeText", items));
      } else {
        const items = [{ page: s.page, id: s.im.id }, ...(everywhere ? s.others.map((q) => ({ page: q, like: { w: s.im.w, h: s.im.h, bbox: s.im.bbox } })) : [])];
        applyInfo(await call("removeImages", items));
      }
      const n = everywhere ? (s.kind === "text" ? s.pages.length : s.others.length) + 1 : 1;
      toast(n > 1 ? t("Deleted on {n} pages. You can undo it.").replace("{n}", n) : t("Deleted. You can undo it."));
    });
    if (window.PDFE_STATS) PDFE_STATS.event("tool_used", { tool: "delete" });
  };

  /* ---------------------------------------------------------------- moving and resizing a picture */
  /** Is page point p inside the selected picture? (a press there moves it, even over text) */
  R.inSelected = (pg, p) => {
    const s = R.sel;
    if (!s || s.kind !== "image" || s.page !== pg) return false;
    const [x0, y0, x1, y1] = s.im.bbox;
    return p.x >= x0 - 3 && p.x <= x1 + 3 && p.y >= y0 - 3 && p.y <= y1 + 3;
  };
  /** A cut-out of the rendered page over the picture, moved with the pointer before the engine redraws. */
  function ghost(pg, box) {
    const el = pageEl(pg), canvas = $("canvas.render", el), layer = $(".layer", el), z = S.zoom;
    const k = canvas.width / S.doc.pages[pg].w;
    const x0 = Math.max(0, Math.floor(box[0] * k)), y0 = Math.max(0, Math.floor(box[1] * k));
    const x1 = Math.min(canvas.width, Math.ceil(box[2] * k)), y1 = Math.min(canvas.height, Math.ceil(box[3] * k));
    const r = [x0 / k, y0 / k, x1 / k, y1 / k];
    const hole = document.createElement("div");
    hole.className = "rm-hole";
    Object.assign(hole.style, { left: r[0] * z + "px", top: r[1] * z + "px", width: (r[2] - r[0]) * z + "px", height: (r[3] - r[1]) * z + "px" });
    hole.style.background = typeof mvBackground === "function" ? mvBackground(canvas, k, r) : "#fff";
    const g = document.createElement("canvas");
    g.className = "rm-ghost"; g.width = Math.max(1, x1 - x0); g.height = Math.max(1, y1 - y0);
    try { g.getContext("2d").drawImage(canvas, x0, y0, g.width, g.height, 0, 0, g.width, g.height); } catch (e) {}
    layer.append(hole, g);
    const place = (b) => {
      const sx = (b[2] - b[0]) / (box[2] - box[0] || 1), sy = (b[3] - b[1]) / (box[3] - box[1] || 1);
      Object.assign(g.style, { left: (b[0] + (r[0] - box[0]) * sx) * z + "px", top: (b[1] + (r[1] - box[1]) * sy) * z + "px",
                               width: (r[2] - r[0]) * sx * z + "px", height: (r[3] - r[1]) * sy * z + "px" });
    };
    place(box);
    return { place, remove: () => { hole.remove(); g.remove(); } };
  }
  /** Where the picture goes for a pointer move of (dx, dy) points: moved, or resized from a corner. */
  function target(pg, b, corner, dx, dy) {
    const P = S.doc.pages[pg];
    if (!corner) {
      dx = Math.max(-b[0], Math.min(P.w - b[2], dx)); dy = Math.max(-b[1], Math.min(P.h - b[3], dy));
      return [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
    }
    const w = b[2] - b[0], h = b[3] - b[1];
    const left = corner.includes("w"), top = corner.includes("n");
    // proportions kept: the pull along the corner's diagonal
    let k = 1 + ((left ? -dx : dx) * w + (top ? -dy : dy) * h) / (w * w + h * h);
    k = Math.max(k, 8 / Math.min(w, h));                         // never smaller than 8 pt
    const ax = left ? b[2] : b[0], ay = top ? b[3] : b[1];      // the corner that stays put
    // never past the page edge
    k = Math.min(k, (left ? ax : P.w - ax) / w, (top ? ay : P.h - ay) / h);
    const nw = w * k, nh = h * k;
    const r = [left ? ax - nw : ax, top ? ay - nh : ay, left ? ax : ax + nw, top ? ay : ay + nh];
    return r;
  }
  /** Press on a picture (or a corner of the selected one): drag it. Returns {move, end} for move.js,
   *  or runs on its own when started from a corner handle (ev given). */
  function drag(ev0, pg, im, corner, forwarded) {
    const el = pageEl(pg), z = S.zoom;
    const start = { x: ev0.clientX, y: ev0.clientY };
    const b = im.bbox.slice();
    let gh = null, box = b, moved = false;
    if (R.sel) for (const x of R.sel.els) x.style.visibility = "hidden";
    bar().hidden = true;
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / z, dy = (ev.clientY - start.y) / z;
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      if (!gh) gh = ghost(pg, b);
      box = target(pg, b, corner, dx, dy);
      gh.place(box);
    };
    const end = async () => {
      if (!forwarded) { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); }
      if (!moved) { if (gh) gh.remove(); return R.selectImage(pg, im); }
      const ok = await busy(async () => {
        const r = await call("moveImage", pg, im.id, box, { w: im.w, h: im.h, bbox: im.bbox });
        applyInfo(r);
        return r;
      });
      // keep the cut-out until the page is redrawn, so nothing flashes
      const done = () => { if (gh) gh.remove(); gh = null; };
      if (ok && ok.changed && ok.changed.length && el._visible) { el.addEventListener("rendered", done, { once: true }); setTimeout(done, 2500); } else done();
      if (ok && ok.changed && ok.changed.length) {
        if (window.PDFE_STATS) PDFE_STATS.event("tool_used", { tool: "imagemove" });
        R.selectImage(pg, { id: ok.id, bbox: ok.bbox, w: im.w, h: im.h });
      } else R.selectImage(pg, im);
    };
    if (!forwarded) { window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end); }
    return { move, end };
  }
  /** move.js: a press on a picture in Edit text mode (move.js forwards the pointer moves and release). */
  R.press = (ev, pg, im) => drag(ev, pg, im, null, true);

  // arrow keys nudge the selected picture (1 pt, Shift 10 pt), applied once the keys stop
  let nudge = null;
  function nudgeBy(dx, dy) {
    const s = R.sel;
    if (!s || s.kind !== "image") return;
    if (!nudge) {
      for (const x of s.els) x.style.visibility = "hidden";
      nudge = { pg: s.page, im: s.im, dx: 0, dy: 0, gh: ghost(s.page, s.im.bbox) };
    }
    const n = nudge, nb = target(n.pg, n.im.bbox, null, n.dx + dx, n.dy + dy);
    n.dx = nb[0] - n.im.bbox[0]; n.dy = nb[1] - n.im.bbox[1];
    n.gh.place(nb);
    clearTimeout(n.timer);
    n.timer = setTimeout(async () => {
      nudge = null;
      const ok = await busy(async () => { const r = await call("moveImage", n.pg, n.im.id, nb, { w: n.im.w, h: n.im.h, bbox: n.im.bbox }); applyInfo(r); return r; });
      const el = pageEl(n.pg), done = () => n.gh.remove();
      if (ok && el._visible) { el.addEventListener("rendered", done, { once: true }); setTimeout(done, 2500); } else done();
      R.selectImage(n.pg, ok && ok.changed && ok.changed.length ? { id: ok.id, bbox: ok.bbox, w: n.im.w, h: n.im.h } : n.im);
    }, 450);
  }

  /** Pictures on a page that can be selected by a click (the smallest one under the pointer). Pictures
   *  that fill the page (a scan, a background) are left out: clicking anywhere would select them. */
  const cache = new Map();
  R.imageAt = (i, x, y) => {
    const p = S.doc.pages[i], list = cache.get(p.v) || [], area = p.w * p.h;
    return list.filter((im) => { const [x0, y0, x1, y1] = im.bbox; return (x1 - x0) * (y1 - y0) <= 0.85 * area && x >= x0 && x <= x1 && y >= y0 && y <= y1; })
      .sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0] || null;
  };
  R.decorate = async (i, el, layer) => {
    const p = S.doc.pages[i], key = p.v;
    let list = cache.get(key);
    if (!list) {
      try { list = await call("pageImages", i); } catch (e) { return; }
      cache.set(key, list);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    if (S.doc.pages[i] !== p || el.dataset.spansV !== p.v + "@" + S.zoom) return;     // redrawn meanwhile
    const area = p.w * p.h, z = S.zoom;
    for (const im of list) {
      const [x0, y0, x1, y1] = im.bbox;
      if ((x1 - x0) * (y1 - y0) > 0.85 * area || x1 - x0 < 4 || y1 - y0 < 4) continue;
      const d = document.createElement("div");
      d.className = "imgpick";
      d.title = t("Click to select this picture");
      Object.assign(d.style, { left: x0 * z + "px", top: y0 * z + "px", width: (x1 - x0) * z + "px", height: (y1 - y0) * z + "px" });
      d.__img = im;                                       // selected from the page's click handler (move.js)
      layer.prepend(d);                                    // under the lines of text
    }
  };

  document.addEventListener("keydown", (e) => {
    if (!R.sel || e.target.closest("input, textarea, select, [contenteditable]")) return;
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); R.remove(false); }
    else if (e.key === "Escape") { e.preventDefault(); R.clear(); }
    else if (dirs[e.key] && R.sel.kind === "image" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const st = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
      nudgeBy(dirs[e.key][0] * st, dirs[e.key][1] * st);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#removeBar, .span.locked, .imgpick, .rm-handle")) return;
    // a press inside the selected picture (even over text) moves it: keep the selection
    const pgEl = e.target.closest && e.target.closest(".page");
    if (R.sel && R.sel.kind === "image" && pgEl && +pgEl.dataset.i === R.sel.page) {
      const r = pgEl.getBoundingClientRect(), p = { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
      if (R.inSelected(R.sel.page, p)) return;
    }
    token++;                                              // a selection still being prepared is dropped too
    if (R.sel) R.clear();
  }, true);
  document.body.addEventListener("toolchange", () => R.clear());
})();
