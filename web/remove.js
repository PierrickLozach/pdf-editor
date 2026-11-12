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
    b.innerHTML = `<span class="rm-what"></span><button class="primary rm-one">${BIN}<span></span></button><button class="rm-all" hidden></button><button class="icon rm-x" title="${esc(t("Cancel (Esc)"))}">✕</button>`;
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
    R.sel.els = els;
    const b = bar();
    b.querySelector(".rm-what").textContent = what;
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
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); R.remove(false); }
    else if (e.key === "Escape") { e.preventDefault(); R.clear(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#removeBar, .span.locked, .imgpick")) return;
    token++;                                              // a selection still being prepared is dropped too
    if (R.sel) R.clear();
  }, true);
  document.body.addEventListener("toolchange", () => R.clear());
})();
