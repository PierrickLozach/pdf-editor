// The developer library used from ANOTHER website (other origin), in Chromium, Firefox and WebKit:
// it loads from /lib/v1/ (CORS), opens, edits, redacts, numbers, splits and saves a PDF there.
// Run: node lib.pw.mjs [chromium|firefox|webkit|all] [library base URL, default http://localhost:8787]
import fs from "node:fs";
import http from "node:http";
import { chromium, firefox, webkit } from "playwright";
const which = process.argv[2] || "all";
const LIBURL = (process.argv[3] || "http://localhost:8787").replace(/\/$/, "");
const page0 = '<!doctype html><meta charset="utf-8"><title>Another website</title>\n<script type="module">\nimport { PDF, VERSION } from "http://localhost:8787/lib/v1/pdf-editor.js";\nwindow.run = async (b64) => {\n  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));\n  const pdf = await PDF.open(new Blob([bytes]));\n  const r = await pdf.replaceAll("Harbour", "Lake");\n  const red = await pdf.redact({ text: "2026" });\n  await pdf.pageNumbers({ format: "{n} / {total}" });\n  const parts = await pdf.split("1");\n  const out = await pdf.save();\n  const back = await PDF.open(out);\n  return { version: VERSION, replaced: r.replaced, redacted: red.redacted, size: out.length, lake: (await back.find("Lake Street")).length, year: (await back.find("2026")).length, parts: parts.length };\n};\nwindow.ready = true;\n</script>\n'.replace("http://localhost:8787", LIBURL);
const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(page0); }).listen(8799, "127.0.0.1");
const pdf = fs.readFileSync(new URL("../fixtures/demo-invoice.pdf", import.meta.url)).toString("base64");
let total = 0;
for (const [n, e] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (which !== "all" && which !== n) continue;
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${n}] ${m}`); if (!c) fails++; };
  const b = await e.launch(); const p = await b.newPage();
  const errs = []; p.on("pageerror", (x) => errs.push(x.message)); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 150)); });
  try {
    await p.goto("http://127.0.0.1:8799/");
    await p.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
    ok(true, `the library loads on another website (http://127.0.0.1:8799 ← ${LIBURL}/lib/v1/)`);
    const r = await p.evaluate((b64) => window.run(b64), pdf);
    ok(r.replaced === 1 && r.lake === 1, "replaceAll() there");
    ok(r.redacted === 2 && r.year === 0, "redact() there: removed from the saved file");
    ok(r.parts === 1 && r.size > 1000, `split() and save() there (${r.size} bytes), version ${r.version}`);
  } catch (x) { fails++; console.log(`  FAIL [${n}] ${x.message.split("\n")[0]} | ${errs.slice(0, 3).join(" ; ")}`); }
  ok(!errs.length, "no errors " + errs.slice(0, 2).join(" ; "));
  await b.close();
  console.log(`  => ${n}: ${fails ? fails + " FAILED" : "ALL OK"}`);
  total += fails;
}
server.close();
console.log(total ? `${total} FAILED` : "ALL BROWSERS OK");
process.exit(total ? 1 : 0);
