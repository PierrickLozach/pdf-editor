// The picture of a PDF in the editor (fictional invoice): site/pages/assets/editor.webp (social preview, search data).
// Run with the local site up (cd site && npm run dev): node pdf-shot.mjs [url]
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
const URL0 = process.argv[2] || "http://127.0.0.1:8787/app/";
const OUT = new URL("../../site/pages/assets/editor.webp", import.meta.url).pathname;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: "en-US", colorScheme: "light" });
await ctx.addInitScript(() => { localStorage.setItem("pdfe.coachSeen", "1"); localStorage.setItem("pdfe.fontIntroSeen", "1"); });
const p = await ctx.newPage();
await p.goto(URL0);
await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
await p.setInputFiles("#fileInput", new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname);
await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey && !S.pending, null, { timeout: 30000 });
await p.waitForTimeout(800);
// a line being edited, in the PDF's own font
const at = await p.evaluate(() => { const s = S.spans[S.doc.pages[0].v].find((x) => /Total due/.test(x.text)) || S.spans[S.doc.pages[0].v][8]; const r = pageEl(0).getBoundingClientRect(); return { x: r.left + (s.tbox[0] + 6) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom }; });
await p.mouse.click(at.x, at.y);
await p.waitForTimeout(700);
await p.screenshot({ path: "/tmp/pdfe-editor.png" });
await b.close();
execFileSync("python3", ["-c", `from PIL import Image; Image.open('/tmp/pdfe-editor.png').convert('RGB').save('${OUT}', 'WEBP', quality=82, method=6)`]);
console.log("saved", OUT);
