// The home page's picture of a Word document in the editor (fictional newsletter): site/pages/assets/documents.webp
// Run with the local site up (cd site && npm run dev): node docs-shot.mjs [url]   then: python3 ../../tools/to_webp.py
import { chromium } from "playwright";
const URL0 = process.argv[2] || "http://127.0.0.1:8787/app/";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: "en-US", colorScheme: "light" });
await ctx.addInitScript(() => { localStorage.setItem("pdfe.coachSeen", "1"); localStorage.setItem("pdfe.fontIntroSeen", "1"); });
const p = await ctx.newPage();
await p.goto(URL0);
await p.waitForFunction(() => document.body.classList.contains("engine-ready"), null, { timeout: 60000 });
await p.setInputFiles("#fileInput", new URL("../fixtures/newsletter.docx", import.meta.url).pathname);
await p.waitForFunction(() => DOCS.isOpen());
const pm = p.frameLocator("#docFrame iframe").locator(".ProseMirror").first();
await pm.waitFor();
await p.waitForTimeout(2500);
// the caret in the first heading, as if someone were editing it
await pm.locator("h2, h1").first().click({ position: { x: 120, y: 12 } }).catch(() => {});
await p.waitForTimeout(600);
await p.screenshot({ path: "/tmp/pdfe-documents.png" });
await b.close();
console.log("saved /tmp/pdfe-documents.png");
