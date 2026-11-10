/* PDF Editor - placing an image (uses the globals of app.js).
 * 1. choose a picture (Image tool)          2. click (or drag) on a page: ONE frame appears
 * 3. move it, resize it with the corners (proportions kept; Shift: free), arrow keys nudge it
 * 4. Enter, "Add" or a click outside the frame adds it once; Esc or "Cancel" drops it
 * Then the editor goes back to Edit text. Nothing is written into the PDF before step 4. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const P = (window.PLACE = { active: null });       // { page, x, y, w, h, el, img }
  const MIN = 8;                                      // smallest side, in points

  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };

  /** Start placing S.image on page i at point (x, y), or in the dragged rectangle. */
  P.start = (i, rect) => {
    P.cancel(true);
    const pg = S.doc.pages[i], im = S.image;
    let [x0, y0, x1, y1] = rect;
    if (x1 - x0 < 4 || y1 - y0 < 4) {                // a click: 160 pt wide, or what fits
      const w = Math.min(160, pg.w - x0 - 4, pg.w * 0.6);
      x1 = x0 + Math.max(MIN, w); y1 = y0 + (x1 - x0) * im.h / im.w;
    } else {                                          // a drag: the picture inside the box, proportions kept
      const sc = Math.min((x1 - x0) / im.w, (y1 - y0) / im.h);
      x1 = x0 + im.w * sc; y1 = y0 + im.h * sc;
    }
    const box = el(`<div class="placer" tabindex="0" role="group" aria-label="${t("Place the image")}">
      <img alt="" draggable="false">
      <span class="ph nw" data-h="nw"></span><span class="ph ne" data-h="ne"></span><span class="ph sw" data-h="sw"></span><span class="ph se" data-h="se"></span>
      <div class="placer-bar"><button class="primary pl-ok">${t("Add")}</button><button class="pl-cancel">${t("Cancel")}</button></div>
    </div>`);
    const url = URL.createObjectURL(im.blob);
    box.querySelector("img").src = url;
    $(".layer", pageEl(i)).appendChild(box);
    P.active = { page: i, x: x0, y: y0, w: x1 - x0, h: y1 - y0, el: box, url, ratio: im.w / im.h };
    clamp(); draw(); bind(box);
    box.focus({ preventScroll: true });
    reveal();
    document.body.classList.add("placing");
    toast(t("Drag the image to move it, a corner to resize it. Enter or “Add” to finish, Esc to cancel."), false, 7000);
  };

  function clamp() {
    const a = P.active, pg = S.doc.pages[a.page];
    a.w = Math.max(MIN, Math.min(a.w, pg.w)); a.h = Math.max(MIN, Math.min(a.h, pg.h));
    a.x = Math.max(0, Math.min(a.x, pg.w - a.w)); a.y = Math.max(0, Math.min(a.y, pg.h - a.h));
  }
  function draw() {
    const a = P.active;
    if (!a) return;
    Object.assign(a.el.style, { left: a.x * S.zoom + "px", top: a.y * S.zoom + "px", width: a.w * S.zoom + "px", height: a.h * S.zoom + "px" });
    // the buttons go below the frame, or above it near the bottom of the page
    const pg = S.doc.pages[a.page];
    a.el.classList.toggle("bar-above", (a.y + a.h) * S.zoom + 44 > pg.h * S.zoom);
  }
  P.redraw = draw;
  /** Scroll so that the frame and its buttons are visible (not hidden under the bottom of the window). */
  function reveal() {
    const a = P.active;
    if (!a) return;
    const v = document.getElementById("viewer"), vr = v.getBoundingClientRect();
    const r = a.el.getBoundingClientRect(), bar = a.el.querySelector(".placer-bar").getBoundingClientRect();
    const top = Math.min(r.top, bar.top) - 16, bottom = Math.max(r.bottom, bar.bottom) + 60;   // room for messages
    if (bottom > vr.bottom) v.scrollTop += Math.min(bottom - vr.bottom, top - vr.top);
    else if (top < vr.top) v.scrollTop -= vr.top - top;
  }

  function bind(box) {
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".placer-bar")) return;
      e.preventDefault(); e.stopPropagation();
      box.focus({ preventScroll: true });
      const a = P.active, h = e.target.dataset.h;
      const start = { mx: e.clientX, my: e.clientY, x: a.x, y: a.y, w: a.w, h: a.h };
      box.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = (ev.clientX - start.mx) / S.zoom, dy = (ev.clientY - start.my) / S.zoom;
        if (!h) { a.x = start.x + dx; a.y = start.y + dy; }
        else {
          // the corner opposite to the one dragged stays put
          let w = start.w + (h.includes("e") ? dx : -dx), hh = start.h + (h.includes("s") ? dy : -dy);
          if (!ev.shiftKey) {                         // keep the proportions (Shift: free); the larger change wins
            if (Math.abs(w / start.w - 1) >= Math.abs(hh / start.h - 1)) hh = w / a.ratio; else w = hh * a.ratio;
          }
          w = Math.max(MIN, w); hh = Math.max(MIN, hh);
          a.x = h.includes("w") ? start.x + start.w - w : start.x;
          a.y = h.includes("n") ? start.y + start.h - hh : start.y;
          a.w = w; a.h = hh;
        }
        clamp(); draw();
      };
      const up = () => { box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up); box.removeEventListener("pointercancel", up); };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", up);
      box.addEventListener("pointercancel", up);
    });
    box.querySelector(".pl-ok").onclick = (e) => { e.stopPropagation(); P.commit(); };
    box.querySelector(".pl-cancel").onclick = (e) => { e.stopPropagation(); P.cancel(); };
    box.addEventListener("keydown", (e) => {
      const a = P.active;
      if (!a) return;
      if (e.key === "Enter") { e.preventDefault(); P.commit(); return; }
      if (e.key === "Escape") { e.preventDefault(); P.cancel(); return; }
      const step = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); a.x += d[0]; a.y += d[1]; clamp(); draw(); }
    });
  }

  /** Add the image where the frame is: one change, one undo step. Then back to Edit text. */
  P.commit = async () => {
    const a = P.active;
    if (!a || a.busy) return;
    a.busy = true;
    const rect = [a.x, a.y, a.x + a.w, a.y + a.h], i = a.page;
    try {
      const bytes = new Uint8Array(await S.image.blob.arrayBuffer());
      const ok = await busy(async () => { applyInfo(await call("addImage", i, rect, bytes, true)); return true; });   // exactly the frame
      if (!ok) { a.busy = false; return; }
    } catch (e) { a.busy = false; return; }
    end();
    S.image = null;
    setTool("edit");
    toast(t("Image added. You can undo it."));
  };
  /** Drop the frame without adding anything. */
  P.cancel = (quiet) => {
    if (!P.active) return;
    end();
    if (quiet !== true) { S.image = null; setTool("edit"); }
  };
  function end() {
    const a = P.active;
    P.active = null;
    if (!a) return;
    a.el.remove();
    URL.revokeObjectURL(a.url);
    document.body.classList.remove("placing");
  }

  // a click elsewhere on the page or the viewer adds the image (like other editors); the toolbar does not
  document.addEventListener("pointerdown", (e) => {
    const a = P.active;
    if (!a || a.el.contains(e.target) || e.target.closest("#toolbar, .dlg, #toast, #sidebar")) return;
    if (e.target.closest("#viewer")) { e.preventDefault(); e.stopPropagation(); P.commit(); }
  }, true);
})();
