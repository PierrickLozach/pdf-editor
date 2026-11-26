// A form's dotted leader ("..........") under the answer typed on it: a click on the answer edits the
// answer, not the dots (the dots' box is smaller, which used to win). Dots alone stay editable.
// Run from tests/pw: node leaders.pw.mjs [chromium|firefox|webkit|all] [url]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = path.join(here, "..", "fixtures", "form-leaders.pdf");
const which = process.argv[2] || "all";
const url = process.argv[3] || "http://127.0.0.1:8766/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0;

async function run(name) {
  let fails = 0;
  const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} [${name}] ${m}`); if (!c) fails++; };
  const browser = await { chromium, firefox, webkit }[name].launch();
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const waitFn = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { if (await page.evaluate(`!!(${expr})`)) return true; } catch (e) {} await sleep(80); }
    return false;
  };
  const spans = () => page.evaluate(() => S.spans[S.doc.pages[0].v] || []);
  const scr = (x, y) => page.evaluate(([x, y]) => { const r = pageEl(0).getBoundingClientRect(); return [r.left + x * S.zoom, r.top + y * S.zoom]; }, [x, y]);
  const clickMid = async (sp, dx = 30) => { const [x, y] = await scr(sp.bbox[0] + dx, (sp.bbox[1] + sp.bbox[3]) / 2); await page.mouse.click(x, y); };
  try {
    await page.goto(url);
    await waitFn(`document.body.classList.contains('engine-ready')`, 60000);
    await page.evaluate(() => { localStorage.setItem("pdfe.fontIntroSeen", "1"); window.PDFE_STATS_TEST = 1; return call("discard"); });
    await page.setInputFiles("#fileInput", pdf);
    await waitFn(`S.doc && pageEl(0).dataset.rkey && S.spans[S.doc.pages[0].v]`);
    const list = await spans();
    const answer = list.find((s) => s.text.includes("Lilas"));
    const dots = list.filter((s) => /^\.+\s*$/.test(s.text.trim()));
    ok(answer && dots.length === 2, "the PDF has the answer and two dotted lines");
    const area = (s) => (s.bbox[2] - s.bbox[0]) * (s.bbox[3] - s.bbox[1]);
    const under = dots.find((d) => d.bbox[1] < answer.bbox[3] && d.bbox[3] > answer.bbox[1]);
    ok(under && area(under) < area(answer), "the dots under the answer have the smaller box (the case that went wrong)");

    await clickMid(answer);
    ok(await waitFn(`S.ed && S.ed.span.text.includes("Lilas")`, 5000), "a click on the answer edits the answer");
    ok(await page.evaluate(() => S.ed && S.ed.box.textContent.includes("12 rue des Lilas")), "the editing box shows the answer's text");
    await page.keyboard.press("Escape");
    await waitFn(`!S.ed`);

    const alone = dots.find((d) => d !== under);
    await clickMid(alone);
    ok(await waitFn(`S.ed && /^\\.+$/.test(S.ed.span.text.trim())`, 5000), "dots with nothing on them can still be edited");
    await page.keyboard.press("Escape");
    ok(!errs.length, `no script errors${errs.length ? ": " + errs.join(" | ") : ""}`);
  } catch (e) { ok(false, "exception: " + e.message); }
  await browser.close();
  total += fails;
}

for (const n of which === "all" ? ["chromium", "firefox", "webkit"] : [which]) await run(n);
console.log(total ? `${total} FAILED` : "all leaders checks passed");
process.exit(total ? 1 : 0);
