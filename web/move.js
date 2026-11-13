/* PDF Editor - moving text, inside the Edit text tool (no separate tool to pick).
 *   click a text        -> edit it
 *   drag a text         -> move its line; it snaps to the edges, centres and baselines of the
 *                          other lines (Alt: move freely, Shift: straight line)
 *   drag on empty space -> select several lines, then drag one of them to move them all
 *   Shift+click         -> add / remove a line;  arrow keys nudge the selection (Shift 10 pt)
 *   while editing       -> drag the move handle (4 arrows) of the box; Enter applies the edit and the move at once
 * The engine really removes the text and redraws it at the new place (moveSpans / editSpan dx, dy).
 * Loaded after app.js and uses its globals (S, call, pageEl, applyInfo, busy, toast, startEdit...). */
"use strict";

const MV = { page: -1, sel: [], nudge: null, busy: false };
const SNAP_PX = 6;      // snapping distance, in screen pixels
const DRAG_PX = 4;      // movement before a press becomes a drag

const lineKey = (sp) => sp.id.split(".").slice(0, 2).join(".");
const mvSpans = (pg) => (S.doc && S.doc.pages[pg] && S.spans[S.doc.pages[pg].v]) || [];
const unionBox = (list, k = "tbox") => list.reduce((u, s) => [Math.min(u[0], s[k][0]), Math.min(u[1], s[k][1]), Math.max(u[2], s[k][2]), Math.max(u[3], s[k][3])], [Infinity, Infinity, -Infinity, -Infinity]);
const fmtPt = (v) => (Math.abs(v) < 0.05 ? "0" : (v > 0 ? "+" : "−") + Math.abs(v).toFixed(1));

async function mvEnsureSpans(pg) {
  const v = S.doc.pages[pg].v;
  if (!S.spans[v]) S.spans[v] = await call("pageText", pg);
  return S.spans[v];
}

/* ---------------------------------------------------------------- selection */
function mvClear() { MV.sel = []; MV.page = -1; mvDraw(); }

function mvHitAt(pg, p) {
  const tol = 1.5;
  const inside = mvSpans(pg).filter((s) => s.editable && s.text.trim() && p.x >= s.bbox[0] - tol && p.x <= s.bbox[2] + tol && p.y >= s.bbox[1] - tol && p.y <= s.bbox[3] + tol);
  inside.sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]));
  return inside[0] || null;
}
const mvLine = (pg, sp) => mvSpans(pg).filter((s) => s.editable && lineKey(s) === lineKey(sp));

function mvSelect(pg, list, additive) {
  if (MV.page !== pg) { MV.sel = []; MV.page = pg; }
  if (!additive) MV.sel = [];
  const ids = new Set(MV.sel.map((s) => s.id));
  if (additive && list.every((s) => ids.has(s.id))) MV.sel = MV.sel.filter((s) => !list.some((x) => x.id === s.id));
  else for (const s of list) if (!ids.has(s.id)) MV.sel.push(s);
  if (!MV.sel.length) MV.page = -1;
  mvDraw();
}

/** After the page changed (a move): find the moved lines again, so arrows can fine-tune them. */
async function mvReselect(pg, prev, delta) {
  const list = await mvEnsureSpans(pg);
  const keys = new Set();
  for (const s of prev) {
    const m = list.find((x) => x.text.trim() === s.text.trim() && Math.abs(x.tbox[0] - s.tbox[0] - delta[0]) < 1.5 && Math.abs(x.tbox[1] - s.tbox[1] - delta[1]) < 1.5);
    if (m) keys.add(lineKey(m));
  }
  MV.sel = list.filter((x) => x.editable && keys.has(lineKey(x)));
  MV.page = MV.sel.length ? pg : -1;
  mvDraw();
}

/* ---------------------------------------------------------------- drawing */
function mvLayer(pg) {
  const el = pageEl(pg);
  if (!el) return null;
  let l = $(".mvlayer", el);
  if (!l) { l = document.createElement("div"); l.className = "mvlayer"; $(".layer", el).appendChild(l); }
  return l;
}
function mvBox(l, cls, r, pad = 1) {
  const d = document.createElement("div"), z = S.zoom;
  d.className = cls;
  Object.assign(d.style, { left: (r[0] - pad) * z + "px", top: (r[1] - pad) * z + "px", width: (r[2] - r[0] + 2 * pad) * z + "px", height: (r[3] - r[1] + 2 * pad) * z + "px" });
  l.appendChild(d);
  return d;
}
function mvDraw() {
  $$(".mvlayer").forEach((l) => { if (+l.closest(".page").dataset.i !== MV.page) l.innerHTML = ""; });
  if (MV.page < 0) return;
  const l = mvLayer(MV.page);
  if (!l) return;
  l.innerHTML = "";
  for (const s of MV.sel) mvBox(l, "mvsel", s.tbox);
}

/** Background colour around a box of the rendered page (to hide the text that leaves it). */
function mvBackground(canvas, k, r) {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const x0 = Math.max(0, Math.floor(r[0] * k) - 2), y0 = Math.max(0, Math.floor(r[1] * k) - 2);
    const w = Math.min(canvas.width - x0, Math.ceil((r[2] - r[0]) * k) + 4), h = Math.min(canvas.height - y0, Math.ceil((r[3] - r[1]) * k) + 4);
    const px = ctx.getImageData(x0, y0, w, h).data, counts = new Map();
    const add = (i) => { const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]; counts.set(key, (counts.get(key) || 0) + 1); };
    for (let x = 0; x < w; x++) { add(x * 4); add(((h - 1) * w + x) * 4); }
    for (let y = 0; y < h; y++) { add(y * w * 4); add((y * w + w - 1) * 4); }
    return "#" + [...counts].sort((a, b) => b[1] - a[1])[0][0].toString(16).padStart(6, "0");
  } catch (e) { return "#ffffff"; }
}

/** Cut-outs of the rendered page, so the text visibly moves before the engine redraws it. */
function mvMakeGhosts(pg) {
  const el = pageEl(pg), canvas = $("canvas.render", el), l = mvLayer(pg);
  const z = S.zoom, k = canvas.width / S.doc.pages[pg].w;
  const ghosts = [];
  for (const s of MV.sel) {
    const r = [s.tbox[0] - 1, s.tbox[1] - 1, s.tbox[2] + 1, s.tbox[3] + 1];
    const x0 = Math.max(0, Math.floor(r[0] * k)), y0 = Math.max(0, Math.floor(r[1] * k));
    const x1 = Math.min(canvas.width, Math.ceil(r[2] * k)), y1 = Math.min(canvas.height, Math.ceil(r[3] * k));
    if (x1 <= x0 || y1 <= y0) continue;
    const box = [x0 / k, y0 / k, x1 / k, y1 / k];
    mvBox(l, "mvhole", box, 0).style.background = mvBackground(canvas, k, box);
    const g = document.createElement("canvas");
    g.className = "mvghost"; g.width = x1 - x0; g.height = y1 - y0;
    g.getContext("2d").drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    Object.assign(g.style, { left: box[0] * z + "px", top: box[1] * z + "px", width: (box[2] - box[0]) * z + "px", height: (box[3] - box[1]) * z + "px" });
    l.appendChild(g);
    ghosts.push({ g, left: box[0], top: box[1] });
  }
  $$(".mvsel", l).forEach((d) => (d.style.visibility = "hidden"));
  return ghosts;
}
function mvPlaceGhosts(ghosts, dx, dy) {
  for (const gh of ghosts) Object.assign(gh.g.style, { left: (gh.left + dx) * S.zoom + "px", top: (gh.top + dy) * S.zoom + "px" });
}

/* ---------------------------------------------------------------- snapping */
/** Edges, centres and baselines of the lines that are not being moved. */
function mvTargets(pg, moving) {
  const skip = new Set(moving.map(lineKey));
  const lines = new Map();
  for (const s of mvSpans(pg)) {
    if (!s.text.trim() || skip.has(lineKey(s)) || Math.abs(s.displayDir[0] - 1) > 0.01) continue;
    const k = lineKey(s);
    const L = lines.get(k) || { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, base: s.origin[1] };
    L.x0 = Math.min(L.x0, s.tbox[0]); L.x1 = Math.max(L.x1, s.tbox[2]);
    L.y0 = Math.min(L.y0, s.tbox[1]); L.y1 = Math.max(L.y1, s.tbox[3]);
    lines.set(k, L);
  }
  return [...lines.values()];
}
function mvSnap(u, bases, dx, dy, targets, free) {
  const res = { dx, dy, gx: null, gy: null };
  if (free) return res;
  const tol = SNAP_PX / S.zoom;
  let bx = null, by = null;
  for (const t of targets) {
    for (const [mine, theirs, kind] of [[u[0], t.x0, "left"], [u[2], t.x1, "right"], [(u[0] + u[2]) / 2, (t.x0 + t.x1) / 2, "centre"]]) {
      const d = theirs - (mine + dx);
      if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d) - 0.01)) bx = { d, x: theirs, kind };
    }
    for (const b of bases) {
      const d = t.base - (b + dy);
      if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d) - 0.01)) by = { d, y: t.base };
    }
  }
  if (bx) { res.dx += bx.d; res.gx = { ...bx, lines: targets.filter((t) => Math.abs((bx.kind === "left" ? t.x0 : bx.kind === "right" ? t.x1 : (t.x0 + t.x1) / 2) - bx.x) < 0.3) }; }
  if (by) { res.dy += by.d; res.gy = { ...by, lines: targets.filter((t) => Math.abs(t.base - by.y) < 0.3) }; }
  return res;
}
function mvGuides(pg, u, snap, dx, dy) {
  const l = mvLayer(pg), z = S.zoom;
  $$(".mvguide, .mvbadge", l).forEach((g) => g.remove());
  if (snap.gx) {
    const ys = [u[1] + dy, u[3] + dy, ...snap.gx.lines.flatMap((t) => [t.y0, t.y1])];
    const d = document.createElement("div");
    d.className = "mvguide v";
    Object.assign(d.style, { left: snap.gx.x * z + "px", top: (Math.min(...ys) - 4) * z + "px", height: (Math.max(...ys) - Math.min(...ys) + 8) * z + "px" });
    l.appendChild(d);
  }
  if (snap.gy) {
    const xs = [u[0] + dx, u[2] + dx, ...snap.gy.lines.flatMap((t) => [t.x0, t.x1])];
    const d = document.createElement("div");
    d.className = "mvguide h";
    Object.assign(d.style, { top: snap.gy.y * z + "px", left: (Math.min(...xs) - 4) * z + "px", width: (Math.max(...xs) - Math.min(...xs) + 8) * z + "px" });
    l.appendChild(d);
  }
  const b = document.createElement("div");
  b.className = "mvbadge";
  b.textContent = `${fmtPt(dx)}, ${fmtPt(dy)} pt` + (snap.gx ? ` · ${snap.gx.kind === "centre" ? "centred" : "aligned " + snap.gx.kind}` : "");
  Object.assign(b.style, { left: (u[0] + dx) * z + "px", top: (u[3] + dy + 4) * z + "px" });
  l.appendChild(b);
}
const mvBases = (list) => [...new Set([...new Map(list.map((s) => [lineKey(s), s])).values()].map((s) => s.origin[1]))];
function mvClamp(pg, u, dx, dy) {
  const p = S.doc.pages[pg];
  return [Math.max(-u[0], Math.min(p.w - u[2], dx)), Math.max(-u[1], Math.min(p.h - u[3], dy))];
}

/* ---------------------------------------------------------------- applying a move */
async function mvCommit(dx, dy) {
  const pg = MV.page, prev = MV.sel.slice();
  if (pg < 0 || !prev.length) return;
  [dx, dy] = mvClamp(pg, unionBox(prev), dx, dy);
  if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) { mvDraw(); return; }
  let ok = false;
  MV.busy = true;
  await busy(async () => { applyInfo(await call("moveSpans", pg, prev.map((s) => ({ id: s.id, expected: s.text })), dx, dy)); ok = true; });
  if (!ok) { MV.busy = false; mvDraw(); return; }
  // keep the cut-outs until the new render arrives, so nothing flashes
  const el = pageEl(pg);
  let done = false;
  const cleanup = async () => { if (done) return; done = true; await mvReselect(pg, prev, [dx, dy]); MV.busy = false; };
  if (el && el._visible) { el.addEventListener("rendered", cleanup, { once: true }); setTimeout(cleanup, 2500); }
  else cleanup();
}

/* ---------------------------------------------------------------- press: click or drag */
function mvPress(e, el, pg) {
  const p0 = ptFromEvent(el, e);
  const touch = e.pointerType === "touch";       // on a touchscreen a finger drag scrolls; the move handle moves
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  // the editor may be applying an edit just now: work on the page as it will be
  const ready = (async () => { if (S.pending) await S.pending; if (!S.doc || !S.doc.pages[pg]) return null; await mvEnsureSpans(pg); return mvHitAt(pg, p0); })();
  let drag = null, starting = false, last = e;
  const move = (ev) => {
    last = ev;
    if (drag) return drag.move(ev);
    if (starting || Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_PX) return;
    if (touch) { cancel(); return; }
    starting = true;
    ready.then((hit) => {
      if (!S.doc) return;
      if (hit) {
        if (!(MV.page === pg && MV.sel.some((s) => s.id === hit.id))) mvSelect(pg, mvLine(pg, hit), additive);
        drag = mvDragSelection(el, pg, p0);
      } else drag = mvBoxSelect(el, pg, p0, additive);
      drag.move(last);
    });
  };
  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", onCancel);
  };
  const onCancel = (ev) => { if (touch) cancel(); else up(ev); };   // the page started scrolling
  const up = (ev) => {
    cancel();
    if (starting) { ready.then(() => drag && drag.end(ev)); return; }
    ready.then((hit) => {
      if (!S.doc) return;
      if (additive && hit) mvSelect(pg, mvLine(pg, hit), true);
      else if (hit) { mvClear(); startEdit(pg, hit); }
      else {
        mvClear();
        // no editable line here: a stamp or a watermark, or a picture, is selected to be deleted
        if (!window.REMOVE) return;
        const b = (r) => p0.x >= r[0] - 2 && p0.x <= r[2] + 2 && p0.y >= r[1] - 2 && p0.y <= r[3] + 2;
        const stamp = mvSpans(pg).filter((x) => !x.editable && !x.ocr && x.text.trim() && b(x.bbox))
          .sort((u, v) => (u.bbox[2] - u.bbox[0]) * (u.bbox[3] - u.bbox[1]) - (v.bbox[2] - v.bbox[0]) * (v.bbox[3] - v.bbox[1]))[0];
        // a tilted line's box is a large rectangle: a picture inside it is the thing clicked on
        const pic = REMOVE.imageAt(pg, p0.x, p0.y);
        if (pic) return REMOVE.selectImage(pg, pic);
        if (stamp) REMOVE.selectText(pg, stamp);
      }
    });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", onCancel);
}

function mvDragSelection(el, pg, start) {
  const targets = mvTargets(pg, MV.sel), u = unionBox(MV.sel), bases = mvBases(MV.sel);
  const ghosts = mvMakeGhosts(pg);
  let res = { dx: 0, dy: 0 };
  document.body.classList.add("mv-dragging");
  return {
    move(ev) {
      const p = ptFromEvent(el, ev);
      let dx = p.x - start.x, dy = p.y - start.y;
      const lock = ev.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? "h" : "v") : null;
      if (lock === "h") dy = 0; else if (lock === "v") dx = 0;
      const snap = mvSnap(u, bases, dx, dy, targets, ev.altKey);
      if (lock === "h") { snap.dy = 0; snap.gy = null; } else if (lock === "v") { snap.dx = 0; snap.gx = null; }
      [dx, dy] = mvClamp(pg, u, snap.dx, snap.dy);
      res = { dx, dy };
      mvPlaceGhosts(ghosts, dx, dy);
      mvGuides(pg, u, snap, dx, dy);
    },
    end() { document.body.classList.remove("mv-dragging"); $$(".mvguide, .mvbadge").forEach((g) => g.remove()); mvCommit(res.dx, res.dy); },
  };
}

function mvBoxSelect(el, pg, a, additive) {
  const rb = document.createElement("div");
  rb.className = "rubber";
  mvLayer(pg).appendChild(rb);
  let b = a;
  return {
    move(ev) {
      b = ptFromEvent(el, ev);
      Object.assign(rb.style, { left: Math.min(a.x, b.x) * S.zoom + "px", top: Math.min(a.y, b.y) * S.zoom + "px",
        width: Math.abs(b.x - a.x) * S.zoom + "px", height: Math.abs(b.y - a.y) * S.zoom + "px" });
    },
    end() {
      rb.remove();
      const r = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
      const keys = new Set(mvSpans(pg).filter((s) => {
        const cx = (s.tbox[0] + s.tbox[2]) / 2, cy = (s.tbox[1] + s.tbox[3]) / 2;
        return s.editable && s.text.trim() && cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3];
      }).map(lineKey));
      mvSelect(pg, mvSpans(pg).filter((s) => s.editable && keys.has(lineKey(s))), additive);
    },
  };
}

/** Arrow keys move the selection (1 pt, Shift 10 pt, Alt 0.25 pt); applied once you pause. */
function mvKey(e) {
  if (S.tool !== "edit" || !S.doc || S.ed || isTyping(e) || $(".dlg:not([hidden])") || !$("#modal").hidden) return false;
  if (e.key === "Escape" && MV.sel.length) { mvClear(); return true; }
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!dirs[e.key] || !MV.sel.length || e.metaKey || e.ctrlKey || MV.busy) return false;
  const step = e.shiftKey ? 10 : e.altKey ? 0.25 : 1, u = unionBox(MV.sel);
  const n = MV.nudge || (MV.nudge = { dx: 0, dy: 0, ghosts: mvMakeGhosts(MV.page) });
  [n.dx, n.dy] = mvClamp(MV.page, u, n.dx + dirs[e.key][0] * step, n.dy + dirs[e.key][1] * step);
  mvPlaceGhosts(n.ghosts, n.dx, n.dy);
  mvGuides(MV.page, u, {}, n.dx, n.dy);
  clearTimeout(n.timer);
  n.timer = setTimeout(() => { const m = MV.nudge; MV.nudge = null; $$(".mvbadge").forEach((g) => g.remove()); mvCommit(m.dx, m.dy); }, 650);
  return true;
}

/* ---------------------------------------------------------------- moving while editing */
/** Called by app.js when the text editor opens: a move handle (4 arrows) to drag the box. */
function edAttach() {
  const ed = S.ed;
  if (!ed || ed.mode !== "edit") return;
  ed.dx = 0; ed.dy = 0;
  const grip = document.createElement("div");
  grip.className = "edgrip";
  grip.title = "Drag to move this text";
  grip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3 9 6m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3"/></svg>';
  $(".layer", pageEl(ed.page)).appendChild(grip);
  ed.extras = [grip];
  const remove = ed.box.remove.bind(ed.box);
  ed.box.remove = () => { remove(); ed.extras.forEach((x) => x.remove()); };   // the handle goes with the box
  grip.addEventListener("pointerdown", (e) => edGripDrag(e, ed));
  edPlaceGrip();
}

/** Keep the handle at the left of the editing box (called whenever the box or the bar moves). */
function edPlaceGrip() {
  const ed = S.ed;
  if (!ed || !ed.extras) return;
  const grip = ed.extras[0], layer = grip.parentElement;
  if (!layer) return;
  const r = ed.box.getBoundingClientRect(), lr = layer.getBoundingClientRect();
  Object.assign(grip.style, { left: r.left - lr.left - 21 + "px", top: r.top - lr.top + (r.height - 18) / 2 + "px" });
}

function edGripDrag(e, ed) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();       // the box keeps the focus and the caret
  const pg = ed.page, el = pageEl(pg), sp = ed.span, z = S.zoom;
  const start = ptFromEvent(el, e), base = [ed.dx, ed.dy];
  const u = sp.tbox, targets = mvTargets(pg, [sp]), bases = [sp.origin[1]];
  if (ed.extras.length === 1) {                  // hide the original text where it was
    const canvas = $("canvas.render", el), k = canvas.width / S.doc.pages[pg].w;
    const hole = document.createElement("div");
    hole.className = "edhole";
    Object.assign(hole.style, { left: (u[0] - 1) * z + "px", top: (u[1] - 1) * z + "px", width: (u[2] - u[0] + 2) * z + "px", height: (u[3] - u[1] + 2) * z + "px", background: mvBackground(canvas, k, u) });
    $(".layer", el).insertBefore(hole, ed.box);
    ed.extras.push(hole);
  }
  document.body.classList.add("mv-dragging");
  const move = (ev) => {
    const p = ptFromEvent(el, ev);
    let dx = base[0] + p.x - start.x, dy = base[1] + p.y - start.y;
    if (ev.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    const snap = mvSnap(u, bases, dx, dy, targets, ev.altKey || ev.shiftKey);
    [dx, dy] = mvClamp(pg, u, snap.dx, snap.dy);
    ed.dx = dx; ed.dy = dy;
    ed.box.style.translate = `${dx * z}px ${dy * z}px`;
    mvGuides(pg, u, snap, dx, dy);
    placeBar();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    document.body.classList.remove("mv-dragging");
    $$(".mvguide, .mvbadge").forEach((g) => g.remove());
    if (S.ed === ed) ed.box.focus();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** Called by app.js each time a page's text boxes are rebuilt (zoom, edit, undo...). */
function mvAfterSpans(pg) {
  if (pg !== MV.page || MV.busy || MV.nudge) return;
  const list = mvSpans(pg);
  if (MV.sel.every((s) => list.some((x) => x.id === s.id && x.text === s.text))) mvDraw();
  else mvClear();
}

/* ---------------------------------------------------------------- wiring */
(function bindMove() {
  // a click on the grey area around the pages clears the selection
  $("#viewer").addEventListener("pointerdown", (e) => { if (MV.sel.length && !e.target.closest(".page")) mvClear(); });
  $("#pages").addEventListener("pointerdown", (e) => {
    if (S.tool !== "edit" || e.button !== 0 || !S.doc) return;
    if (e.target.closest(".editbox, .edgrip, .notext, .ffield, .ff-input")) return;   // typing in the box, its handle, a form field
    const el = e.target.closest(".page");
    if (!el) return;
    if (e.pointerType !== "touch") e.preventDefault();   // touch: let the finger scroll
    e.stopPropagation();                         // text clicks and drags are handled here
    mvPress(e, el, +el.dataset.i);
  }, true);
  document.addEventListener("keydown", (e) => { if (mvKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  // Home / End in the editing box: move within the line ourselves (Chrome otherwise also scrolls
  // the whole page to its top / bottom once the box closes)
  document.addEventListener("keydown", (e) => {
    if (!S.ed || e.target !== S.ed.box || (e.key !== "Home" && e.key !== "End") || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const sel = document.getSelection();
    if (sel && sel.modify) sel.modify(e.shiftKey ? "extend" : "move", e.key === "Home" ? "backward" : "forward", "lineboundary");
  }, true);
  document.body.addEventListener("toolchange", () => { if (S.tool !== "edit") mvClear(); });
})();
