// The social preview (site/pages/assets/og.png, 1200 × 630) from the two home page pictures, editor.webp
// (a PDF) and documents.webp (a Word document). Run: node og.mjs
import { chromium } from "playwright";
import fs from "node:fs";
const A = new URL("../../site/pages/assets/", import.meta.url).pathname;
const img = (f) => "data:image/webp;base64," + fs.readFileSync(A + f).toString("base64");
const b = await chromium.launch();
const og = await (await b.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })).newPage();
await og.setContent(`<html><body style="margin:0;width:1200px;height:630px;overflow:hidden;font-family:-apple-system,Helvetica,Arial,sans-serif;background:linear-gradient(135deg,#fff 0%,#fff 55%,#fde8e7 100%)">
  <div style="position:absolute;left:64px;top:64px;display:flex;align-items:center;gap:14px;font-weight:700;font-size:30px;color:#1d2129">
    <span style="width:52px;height:52px;border-radius:14px;background:#e5322d;color:#fff;display:grid;place-items:center;font-size:30px">Q</span>Quicktou</div>
  <div style="position:absolute;left:64px;top:160px;width:560px;font-size:54px;line-height:1.08;font-weight:800;color:#1d2129;letter-spacing:-1px">Edit PDFs and Word documents in your browser. Free.</div>
  <div style="position:absolute;left:64px;top:452px;width:520px;font-size:25px;line-height:1.35;color:#5b6170">Real text editing in the original font. Your files never leave your computer.</div>
  <img src="${img("editor.webp")}" style="position:absolute;left:690px;top:60px;width:620px;border-radius:14px;box-shadow:0 20px 60px rgba(16,24,40,.25);border:1px solid #e3e6ea">
  <div style="position:absolute;left:610px;top:320px;width:470px;height:270px;overflow:hidden;border-radius:12px;box-shadow:0 18px 50px rgba(16,24,40,.30);border:1px solid #e3e6ea;background:#fff"><img src="${img("documents.webp")}" style="width:470px;display:block"></div>
</body></html>`);
await og.waitForTimeout(300);
await og.screenshot({ path: A + "og.png" });
await b.close();
console.log(fs.statSync(A + "og.png").size);
