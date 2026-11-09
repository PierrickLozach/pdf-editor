// Landing-page images, made from the real editor with a fictional demo invoice (never a real document):
//   site/pages/assets/editor.webp  (screenshot)     site/pages/assets/og.png  (social preview, 1200 × 630)
// Needs the local site running (cd site && npm run dev). Run: node shots.mjs /path/to/demo.pdf
import { chromium } from "playwright";
import fs from "node:fs";
const BASE = "http://127.0.0.1:8787";
const OUT = new URL("../../site/pages/assets/", import.meta.url).pathname;
const demo = process.argv[2] || "/tmp/pdfe-demo/demo-invoice.pdf";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: "light" });
const page = await ctx.newPage();
const waitFn = async (expr, t = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; };
await page.goto(BASE + "/app/");
await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
await page.evaluate(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); return call("discard"); });
await page.setInputFiles("#fileInput", demo);
await waitFn(`S.doc && S.spans[S.doc.pages[0].v] && pageEl(0).dataset.rkey`);
await page.evaluate(() => setZoom(1.25));
await waitFn(`pageEl(0).dataset.rkey && pageEl(0).dataset.rkey.endsWith("@" + renderScale())`);
await new Promise((r) => setTimeout(r, 800));
const sp = await page.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => x.text.startsWith("Payment by bank")); const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 4) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
await page.mouse.click(sp.x, sp.y);
await waitFn(`S.ed && document.activeElement === S.ed.box`);
await page.evaluate(() => { const sel = document.getSelection(); sel.selectAllChildren(S.ed.box); sel.collapseToEnd(); });
for (let i = 0; i < "30 days.".length; i++) await page.keyboard.press("Backspace");
await page.keyboard.type("15 days, thank you.");
await new Promise((r) => setTimeout(r, 600));
await page.mouse.move(5, 600);
const png = await page.screenshot();
// WebP, encoded by the browser itself
const toWebp = async (buf, w, h, q) => page.evaluate(async ({ b64, w, h, q }) => {
  const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
  const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, "image/webp", q));
  return [...new Uint8Array(await blob.arrayBuffer())];
}, { b64: buf.toString("base64"), w, h, q });
fs.writeFileSync(OUT + "editor.webp", Buffer.from(await toWebp(png, 1600, 1000, 0.82)));

// social preview: brand, headline, and the screenshot
const og = await ctx.newPage();
await og.setViewportSize({ width: 1200, height: 630 });
await og.setContent(`<html><body style="margin:0;width:1200px;height:630px;overflow:hidden;font-family:-apple-system,Helvetica,Arial,sans-serif;background:linear-gradient(135deg,#fff 0%,#fff 55%,#fde8e7 100%)">
  <div style="position:absolute;left:64px;top:64px;display:flex;align-items:center;gap:14px;font-weight:700;font-size:30px;color:#1d2129">
    <span style="width:52px;height:52px;border-radius:14px;background:#e5322d;color:#fff;display:grid;place-items:center;font-size:30px">P</span>PDF Editor</div>
  <div style="position:absolute;left:64px;top:170px;width:560px;font-size:60px;line-height:1.08;font-weight:800;color:#1d2129;letter-spacing:-1px">Edit any PDF in your browser. Free.</div>
  <div style="position:absolute;left:64px;top:410px;width:520px;font-size:26px;line-height:1.35;color:#5b6170">Real text editing in the original font. Your files never leave your computer.</div>
  <img src="data:image/png;base64,${png.toString("base64")}" style="position:absolute;left:660px;top:70px;width:900px;border-radius:14px;box-shadow:0 20px 60px rgba(16,24,40,.25);border:1px solid #e3e6ea">
</body></html>`);
await og.screenshot({ path: OUT + "og.png" });
await b.close();
console.log("editor.webp", fs.statSync(OUT + "editor.webp").size, "bytes · og.png", fs.statSync(OUT + "og.png").size, "bytes");
