// Undo / redo: the toolbar buttons and the keyboard (⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y),
// after every kind of change, wherever the focus is, and on non-Latin keyboards (Arabic, Hebrew…).
// Run: node undo.pw.mjs [chromium|firefox|webkit|all] [url]
import { chromium, firefox, webkit } from "playwright";

const which = process.argv[2] || "all";
const URL0 = process.argv[3] || "http://localhost:8787/app/";
const pdf = new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname;
const png = new URL("../../web/icon.png", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, engine) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  await ctx.addInitScript(() => localStorage.setItem("pdfe.fontIntroSeen", "1"));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const waitFn = async (expr, timeout = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(60); } return false; };
  const idle = () => waitFn(`!document.body.classList.contains("busy") && !S.pending`);
  // what the document looks like: pages, rotation, every text, number of images
  const fp = () => page.evaluate(async () => {
    const t = [];
    for (let i = 0; i < S.doc.pages.length; i++) t.push((await call("pageText", i)).map((s) => s.text.trim()).join("|"));
    const b = await call("export");
    const imgs = (new TextDecoder("latin1").decode(b).match(/\/Subtype\s*\/Image/g) || []).length;
    return JSON.stringify({ pages: S.doc.pages.map((p) => p.rotation), t, imgs });
  });
  const buttons = () => page.evaluate(() => ({ undo: !document.querySelector("#btnUndo").disabled, redo: !document.querySelector("#btnRedo").disabled }));
  const MOD = process.platform === "darwin" ? "Meta" : "Control";
  const doIt = (op, ...args) => page.evaluate(async ([op, args]) => { applyInfo(await call(op, ...args)); }, [op, args]);

  try {
    await page.goto(URL0);
    await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
    await page.setInputFiles("#fileInput", pdf);
    await waitFn(`S.doc && pageEl(0).dataset.rkey`);
    const f0 = await fp();
    let b = await buttons();
    ok(!b.undo && !b.redo, "a freshly opened PDF: Undo and Redo greyed out");
    ok(await page.isVisible("#btnUndo") && await page.isVisible("#btnRedo"), "both buttons are in the toolbar");
    const labels = await page.evaluate(() => [document.querySelector("#btnUndo").getAttribute("aria-label") || document.querySelector("#btnUndo").title, document.querySelector("#btnRedo").getAttribute("aria-label") || document.querySelector("#btnRedo").title]);
    ok(/Undo/.test(labels[0]) && /Redo/.test(labels[1]), "they say what they do: " + labels.join(" / "));
    ok(await page.evaluate(() => document.querySelector("#btnUndo span").textContent === "Undo" && document.querySelector("#btnRedo span").textContent === "Redo"), "labelled “Undo” and “Redo” (when the window is wide enough)");

    // ---------------------------------------------------------------- an action that changes nothing is not an undo step
    await doIt("addText", 0, 60, 500, "Temporary", {}); await idle();
    await page.click("#btnUndo"); await idle();                     // Redo is now available
    const r1 = await page.evaluate(async () => { const r = await call("reduceSize", "smaller"); applyInfo(r); return r.images; });
    const r2 = await page.evaluate(async () => { const r = await call("removeActiveContent"); applyInfo(r); return r.removed.total; });
    await idle();
    b = await buttons();
    ok(r1 === 0 && r2 === 0 && b.redo && !b.undo, "“Reduce file size” / removing active content with nothing to do: no undo step, the Redo history is kept");
    ok((await fp()) === f0, "…the document is untouched");
    await page.keyboard.press(`${MOD}+Shift+z`); await idle();
    ok((await fp()) !== f0, "…and Redo still brings the last change back");
    await page.keyboard.press(`${MOD}+z`); await idle();
    ok((await fp()) === f0, "undo it again");

    // ---------------------------------------------------------------- every kind of change, undone and redone
    const sp = await page.evaluate(() => call("pageText", 0).then((l) => l.find((s) => s.text.trim() === "14 Harbour Street")));
    const changes = [
      ["edit text", () => doIt("editSpan", 0, sp.id, sp.text, "27 Mill Lane")],
      ["add text", () => doIt("addText", 0, 60, 500, "Added line", {})],
      ["whiteout", () => doIt("erase", 0, [380, 60, 560, 110])],
      ["image", async () => { const bytes = await page.evaluate(async () => { const r = await fetch("icon.png"); return [...new Uint8Array(await r.arrayBuffer())]; }); await page.evaluate(async (bb) => { applyInfo(await call("addImage", 0, [300, 600, 400, 700], new Uint8Array(bb), true)); }, bytes); }],
      ["move text", async () => { const s2 = await page.evaluate(() => call("pageText", 0).then((l) => l.find((s) => s.text.trim() === "Blue Harbor Consulting"))); await doIt("moveSpans", 0, [{ id: s2.id, expected: s2.text }], 40, 20); }],
      ["replace all", () => doIt("replaceAll", "Riverside", "Lakeside")],
      ["rotate page", () => page.evaluate(() => pageAction("rotate", 0))],
      ["duplicate page", () => page.evaluate(() => pageAction("duplicate", 0))],
    ];
    const states = [f0];
    for (const [label, fn] of changes) {
      await fn(); await idle();
      const f = await fp();
      ok(f !== states[states.length - 1], `${label}: the document changed`);
      states.push(f);
      b = await buttons();
      ok(b.undo && !b.redo, `${label}: Undo available, Redo greyed out`);
    }
    // undo everything with the button
    for (let i = changes.length - 1; i >= 0; i--) {
      await page.click("#btnUndo"); await idle();
      ok((await fp()) === states[i], `Undo button: “${changes[i][0]}” undone`);
    }
    b = await buttons();
    ok(!b.undo && b.redo, "back to the original: Undo greyed out, Redo available");
    ok((await fp()) === f0, "the document is exactly the original again");
    // redo everything with the keyboard
    for (let i = 0; i < changes.length; i++) {
      await page.keyboard.press(`${MOD}+Shift+z`); await idle();
      ok((await fp()) === states[i + 1], `${MOD === "Meta" ? "⇧⌘Z" : "Ctrl+Shift+Z"}: “${changes[i][0]}” redone`);
    }
    b = await buttons();
    ok(b.undo && !b.redo, "all redone: Redo greyed out");
    // undo with the keyboard, redo with the button and Ctrl+Y
    await page.keyboard.press(`${MOD}+z`); await idle();
    ok((await fp()) === states[changes.length - 1], `${MOD === "Meta" ? "⌘Z" : "Ctrl+Z"} undoes`);
    await page.click("#btnRedo"); await idle();
    ok((await fp()) === states[changes.length], "Redo button redoes");
    await page.keyboard.press(`${MOD}+z`); await idle();
    await page.keyboard.press("Control+y"); await idle();
    ok((await fp()) === states[changes.length], "Ctrl+Y redoes too (Windows habit)");

    // ---------------------------------------------------------------- wherever the focus is
    const last = states[changes.length], prev = states[changes.length - 1];
    await page.click("#btnZoomIn"); await idle();                         // focus on a toolbar button
    await page.keyboard.press(`${MOD}+z`); await idle();
    ok((await fp()) === prev, "focus on a toolbar button: ⌘Z still undoes the document");
    await page.keyboard.press(`${MOD}+Shift+z`); await idle();
    await page.click("#pages", { position: { x: 5, y: 5 } }).catch(() => {});
    await page.locator("#thumbs .thumb").first().click(); await idle();   // focus in the page list
    await page.keyboard.press(`${MOD}+z`); await idle();
    ok((await fp()) === prev, "focus in the page list: ⌘Z undoes");
    await page.keyboard.press(`${MOD}+Shift+z`); await idle();
    // the find box keeps its own text undo
    await page.keyboard.press(`${MOD}+f`);
    await waitFn(`!document.querySelector('#findPanel').hidden`);
    await page.fill("#findInput", "");
    await page.keyboard.type("abc");
    await page.keyboard.press(`${MOD}+z`); await sleep(300);
    ok((await fp()) === last, "typing in the find box: ⌘Z undoes the typing, not the document");
    await page.keyboard.press("Escape");
    // while editing a line: ⌘Z first undoes the typing; with nothing typed it closes the box and undoes the document
    const pos = await page.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === "NORTHWIND STUDIO"); const r = pageEl(0).getBoundingClientRect(); return s && { x: r.left + (s.tbox[0] + 4) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
    if (pos) {
      await page.evaluate(() => { document.querySelector("#viewer").scrollTop = 0; }); await sleep(200);
      const p2 = await page.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === "NORTHWIND STUDIO"); const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 4) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
      await page.mouse.click(p2.x, p2.y);
      await waitFn(`S.ed && document.activeElement === S.ed.box`);
      await page.keyboard.press(`${MOD}+z`); await idle();
      ok(await waitFn(`!S.ed`) && (await fp()) === prev, "editing a line, nothing typed yet: ⌘Z closes the box and undoes the last change");
      await page.keyboard.press(`${MOD}+Shift+z`); await idle();
    } else ok(false, "the test line is on the page");
    // during image placement: ⌘Z drops the frame first
    await page.keyboard.press("i"); await page.setInputFiles("#imageInput", png);
    await waitFn(`S.tool === "image" && S.image`);
    const pr = await page.evaluate(() => { const r = pageEl(0).getBoundingClientRect(); return { x: r.left, y: r.top, z: S.zoom }; });
    await page.mouse.click(pr.x + 200 * pr.z, pr.y + 300 * pr.z);
    await waitFn(`PLACE.active`);
    await page.keyboard.press(`${MOD}+z`); await idle();
    ok(await waitFn(`!PLACE.active`) && (await fp()) === last, "placing an image: ⌘Z drops the frame, the document is not touched");

    // ---------------------------------------------------------------- other keyboard layouts
    for (const [lang, key] of [["Arabic", "ئ"], ["Hebrew", "ז"], ["Russian", "я"]]) {
      await page.evaluate((k) => {
        const mac = /Mac/.test(navigator.platform);
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: "KeyZ", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
      }, key);
      await idle();
      ok((await fp()) === prev, `${lang} keyboard (the Z key types “${key}”): ⌘Z / Ctrl+Z still undoes`);
      await page.keyboard.press(`${MOD}+Shift+z`); await idle();
    }
    // ---------------------------------------------------------------- a Windows computer: tooltips say Ctrl
    {
      const wc = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", locale: "fr-FR" });
      await wc.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Win32" }));
      const wp = await wc.newPage();
      await wp.goto(URL0);
      await wp.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
      await sleep(300);
      const tips = await wp.evaluate(() => [document.querySelector("#btnUndo").title, document.querySelector("#btnRedo").title, document.querySelector("#btnSave").title]);
      ok(tips[0] === "Annuler (Ctrl+Z)" && tips[1] === "Rétablir (Ctrl+Shift+Z)" && !/⌘/.test(tips[2]), "Windows, in French: “" + tips.join("”, “") + "”");
      await wc.close();
    }
    ok(errs.length === 0, "no script errors " + errs.slice(0, 3).join(" | "));
  } catch (e) {
    fails++; console.log(`  FAIL [${name}] exception: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `/tmp/pdfe-site/undo-${name}-failure.png` }).catch(() => {});
  }
  await browser.close();
  console.log(`  => ${name}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  return fails;
}

let total = 0;
for (const [n, e] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) if (which === "all" || which === n) total += await run(n, e);
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
