/* PDF Editor - Redact (uses the globals of app.js and tools.js).
 *  Mark areas (drag boxes on the pages) and/or every place a word appears, check them, then apply:
 *  what is under each box (text, pictures, drawings) is removed from the file for good and a black
 *  box is drawn. Unlike Whiteout, nothing can be recovered from the saved file. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const esc = (s) => (window.TOOLS ? TOOLS.esc(s) : String(s));
  const R = (window.REDACT = { on: false, marks: [] });       // marks: {page, rect, el}
  const el = (html) => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstElementChild; };

  function bar() {
    let b = document.getElementById("redactBar");
    if (b) return b;
    b = el(`<div id="redactBar" class="redact-bar" role="region" aria-label="${esc(t("Redact"))}" hidden>
      <span class="rb-title"><b>${esc(t("Redact"))}</b> – ${esc(t("drag over what must disappear, or mark a word everywhere"))}</span>
      <span class="rb-find"><input type="search" class="rb-word" placeholder="${esc(t("Word or number to remove everywhere"))}" aria-label="${esc(t("Word or number to remove everywhere"))}"><button class="rb-mark">${esc(t("Mark all"))}</button></span>
      <span class="rb-count" aria-live="polite"></span>
      <span class="rb-actions"><button class="rb-cancel">${esc(t("Cancel"))}</button><button class="primary rb-apply" disabled>${esc(t("Apply redactions"))}</button></span>
    </div>`);
    document.body.appendChild(b);                         // floats over the pages: they do not move when it opens
    b.querySelector(".rb-cancel").onclick = () => R.stop();
    b.querySelector(".rb-apply").onclick = () => R.apply();
    const word = b.querySelector(".rb-word");
    b.querySelector(".rb-mark").onclick = () => R.markWord(word.value);
    word.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); R.markWord(word.value); } if (e.key === "Escape") { e.preventDefault(); R.stop(); } });
    return b;
  }
  function count() {
    const b = bar(), n = R.marks.length;
    b.querySelector(".rb-count").textContent = n ? (n === 1 ? t("1 area marked") : t("{n} areas marked").replace("{n}", n)) : "";
    b.querySelector(".rb-apply").disabled = !n;
  }
  function draw(m) {
    const layer = $(".layer", pageEl(m.page));
    if (!layer) return;
    if (!m.el) {
      m.el = el(`<div class="redact-mark" title="${esc(t("Click to unmark"))}"></div>`);
      m.el.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
      m.el.addEventListener("click", (e) => { e.stopPropagation(); R.marks = R.marks.filter((x) => x !== m); m.el.remove(); count(); });
    }
    if (!m.el.isConnected) layer.appendChild(m.el);
    const r = m.rect;
    Object.assign(m.el.style, { left: r[0] * S.zoom + "px", top: r[1] * S.zoom + "px", width: (r[2] - r[0]) * S.zoom + "px", height: (r[3] - r[1]) * S.zoom + "px" });
  }
  R.redraw = () => R.marks.forEach(draw);
  R.add = (page, rect) => { const m = { page, rect }; R.marks.push(m); draw(m); count(); };

  R.start = () => {
    if (!S.doc) return;
    closeEditor(true);
    R.on = true; R.marks = [];
    setTool("redact");
    const b = bar();
    b.hidden = false;
    count();
    b.querySelector(".rb-word").value = "";
    toast(t("Drag over what must disappear for good. Click a marked area to unmark it."), false, 6000);
  };
  R.stop = () => {
    for (const m of R.marks) if (m.el) m.el.remove();
    R.marks = []; R.on = false;
    bar().hidden = true;
    if (S.tool === "redact") setTool("edit");
  };
  R.markWord = async (word) => {
    word = String(word || "").trim();
    if (!word) return;
    const hits = await call("find", word, false, false);
    if (!hits.length) return toast(t("“{word}” is not in this PDF").replace("{word}", word), true);
    let added = 0;
    for (const h of hits) {
      const r = [h.bbox[0] - 1, h.bbox[1] - 1, h.bbox[2] + 1, h.bbox[3] + 1];
      if (R.marks.some((m) => m.page === h.page && Math.abs(m.rect[0] - r[0]) < 0.5 && Math.abs(m.rect[1] - r[1]) < 0.5)) continue;
      R.add(h.page, r); added++;
    }
    toast(t("“{word}” marked {n} times. Check the pages, then apply.").replace("{word}", word).replace("{n}", added), false, 6000);
    const first = R.marks.find((m) => m.page === hits[0].page);
    if (first && first.el) first.el.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  R.apply = async () => {
    if (!R.marks.length) return;
    const n = R.marks.length;
    if (!(await modal({ title: t("Apply redactions?"), text: t("The marked areas ({n}) are removed for good: text, pictures and drawings under them. You can still undo it until you close the PDF; the saved file cannot be recovered.").replace("{n}", n), ok: t("Apply redactions"), danger: true }))) return;
    const areas = R.marks.map((m) => ({ page: m.page, rect: m.rect }));
    await busy(async () => {
      applyInfo(await call("redact", areas));
      toast(t("{n} areas redacted. Save the PDF to keep it.").replace("{n}", n), false, 6000);
    });
    R.stop();
  };
  // the marks follow zoom and re-rendered pages
  document.body.addEventListener("toolchange", () => { if (R.on && S.tool !== "redact") R.stop(); });
})();
