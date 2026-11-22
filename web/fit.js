/* PDF Editor - keep the toolbar on one line whatever the language and the window width:
 * hide button labels step by step (fit1: file buttons, fit2: all, fit3: the "saved" note…), then, when
 * the buttons alone still do not fit (a phone), move the least used ones into a "⋯" menu that always
 * stays in view. Nothing is ever hidden behind a horizontal scroll. */
(function () {
  const tb = document.getElementById("toolbar");
  if (!tb) return;
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const STEPS = ["fit1", "fit2", "fit3", "fit4", "fit5", "fit6"];    // fit5: the name goes (it stays in the tab title); fit6: the zoom buttons go (⌘+ / ⌘− and pinch still zoom)
  // what goes into the "⋯" menu first; Pages, Save, Undo and Edit text always stay in the toolbar
  // (with a PDF open, Open is less useful than Whiteout and Add text: the start screen has its own big button)
  const ORDER = ["#btnFonts", "#btnLang", "#btnFind", "#btnRedo", "#btnDownload", "#btnTools",
                 '[data-tool="image"]', "#btnOpen", '[data-tool="erase"]', '[data-tool="add"]'];

  /* ---------------------------------------------------------------- the "⋯" button and its menu */
  const group = document.createElement("div");
  group.className = "group more off";
  group.innerHTML = `<button id="btnMore" class="icon" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>`;
  const zoom = tb.querySelector(".group.zoom");
  zoom ? tb.insertBefore(group, zoom) : tb.appendChild(group);
  const more = group.firstElementChild;
  const label = () => { const s = t("More"); if (more.title !== s) { more.title = s; more.setAttribute("aria-label", s); } };
  label();
  if (window.I18N && I18N.ready) I18N.ready.then(label);

  const menu = document.createElement("div");
  menu.id = "moreMenu"; menu.className = "tools-menu more-menu"; menu.setAttribute("role", "menu"); menu.hidden = true;
  document.body.appendChild(menu);

  const textOf = (b) => { const s = b.querySelector(":scope > span"); return (s && s.textContent.trim()) || b.getAttribute("aria-label") || b.title || ""; };
  /** One menu line that clicks the real button (its handlers, shortcuts and state stay in one place). */
  function entry(target, icon, title, sub) {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    if (icon) b.appendChild(icon.cloneNode(true));
    const s = document.createElement("span"), bt = document.createElement("b");
    bt.textContent = title; s.appendChild(bt);
    if (sub) { const sm = document.createElement("small"); sm.textContent = sub; s.appendChild(sm); }
    b.appendChild(s);
    b.disabled = !!target.disabled;
    b.onclick = (e) => { e.stopPropagation(); close(); target.click(); };
    return b;
  }
  function build() {
    menu.textContent = "";
    const moved = [...tb.querySelectorAll("button.ovf")].filter((b) => !b.hidden);
    for (const b of moved) {
      if (b.id === "btnTools") continue;                       // its tools are listed one by one below
      menu.appendChild(entry(b, b.querySelector("svg"), textOf(b), b.id === "btnLang" ? t("Language") : ""));
    }
    const tools = moved.find((b) => b.id === "btnTools");
    const tm = document.getElementById("toolsMenu");
    if (tools && tm) {
      if (window.TOOLS && TOOLS.sortMenu) TOOLS.sortMenu();
      const h = document.createElement("p");
      h.className = "mm-head"; h.textContent = textOf(tools) || t("Tools");
      menu.appendChild(h);
      for (const it of tm.querySelectorAll(":scope > button")) {
        const b = it.querySelector("span > b"), sm = it.querySelector("span > small");
        const name = b ? [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() || b.textContent.trim() : it.textContent.trim();
        const e = entry(it, it.querySelector("svg"), name, sm ? sm.textContent.trim() : "");
        if (tools.disabled) e.disabled = true;                  // the tools need an open PDF
        menu.appendChild(e);
      }
    }
  }
  function close() { if (!menu.hidden) { menu.hidden = true; more.setAttribute("aria-expanded", "false"); } }
  function open() {
    build();
    menu.hidden = false;
    const r = more.getBoundingClientRect(), w = menu.offsetWidth, rtl = document.documentElement.dir === "rtl";
    const x = rtl ? r.left : r.right - w;
    Object.assign(menu.style, { top: r.bottom + 6 + "px", left: Math.min(Math.max(8, x), innerWidth - w - 8) + "px" });
    more.setAttribute("aria-expanded", "true");
    const first = menu.querySelector("button:not(:disabled)");
    if (first) first.focus();
  }
  more.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !more.contains(e.target)) close(); }, true);
  menu.addEventListener("keydown", (e) => {
    const bs = [...menu.querySelectorAll("button:not(:disabled)")], i = bs.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(); more.focus(); }
    else if (e.key === "ArrowDown" && bs.length) { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (e.key === "ArrowUp" && bs.length) { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
  });
  window.TOOLBAR_MORE = { open, close, el: menu, button: more };

  /* ---------------------------------------------------------------- fitting */
  // class changes only: the watcher below reacts to "hidden" and "disabled", so fitting never re-triggers itself
  const fits = () => tb.scrollWidth <= tb.clientWidth + 1;
  const shown = (el) => !el.hidden && getComputedStyle(el).display !== "none";
  function groups() {
    for (const g of tb.querySelectorAll(".group:not(.more)"))
      g.classList.toggle("ovf-empty", [...g.children].every((c) => c.classList.contains("ovf") || !shown(c)));
  }
  let busy = false;
  function fit() {
    if (busy) return;
    busy = true;
    tb.classList.remove(...STEPS);
    for (const b of tb.querySelectorAll(".ovf")) b.classList.remove("ovf");
    for (const g of tb.querySelectorAll(".ovf-empty")) g.classList.remove("ovf-empty");
    group.classList.add("off");
    for (const s of STEPS) {
      if (fits()) break;
      tb.classList.add(s);
    }
    if (!fits()) {
      group.classList.remove("off");
      for (const sel of ORDER) {
        const b = tb.querySelector(sel);
        if (!b || !shown(b)) continue;
        b.classList.add("ovf");
        groups();
        if (fits()) break;
      }
    }
    if (!menu.hidden) build();
    busy = false;
  }
  new ResizeObserver(fit).observe(tb);
  new MutationObserver(() => requestAnimationFrame(fit)).observe(tb, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  document.addEventListener("DOMContentLoaded", fit);
  window.addEventListener("load", fit);
  window.addEventListener("resize", close);
  fit();
})();
