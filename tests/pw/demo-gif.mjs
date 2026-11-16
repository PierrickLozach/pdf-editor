// Records a short demo of the editor for the announcements, on the fictional test invoice:
// open a PDF, click an amount, retype it (same font, same place), fix the total, download.
// Frames come from Chromium's screencast; tools/make_gif.py turns them into a GIF.
// Run: node demo-gif.mjs [base url] [out dir]   (default: the local server, /tmp/demo-frames)
import fs from "node:fs";
import { chromium } from "playwright";
const B = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const OUT = process.argv[3] || "/tmp/demo-frames";
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440, H = 900;

const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light", locale: "en-US", acceptDownloads: true,
  bypassCSP: true });                                      // only so the demo's own pointer and captions can be drawn
await c.addInitScript(() => {
  localStorage.setItem("pdfe.fontIntroSeen", "1"); localStorage.setItem("pdfe.coachSeen", "1");   // the captions say it
  window.showSaveFilePicker = undefined; window.showOpenFilePicker = undefined;     // the plain file dialog, as most visitors see it
  // a visible mouse pointer (screen captures do not show the real one) and a ring on each click
  addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = `#demoCursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px)}
      #demoCursor svg{width:26px;height:26px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
      .demoRing{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #e5322d;z-index:2147483646;pointer-events:none;animation:demoRing .55s ease-out forwards}
      @keyframes demoRing{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
      #demoCap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;background:rgba(20,22,26,.88);color:#fff;
        font:600 22px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px 24px;border-radius:12px;white-space:nowrap;transition:opacity .25s}
      #demoCap b{color:#ff8a80;font-weight:700}`;
    document.head.appendChild(st);
    const cur = document.createElement("div"); cur.id = "demoCursor";
    cur.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1 3.8 7.2-2.9 1.5-3.8-7.3L4 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    const cap = document.createElement("div"); cap.id = "demoCap"; cap.style.opacity = "0"; document.body.appendChild(cap);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => { const r = document.createElement("div"); r.className = "demoRing"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 600); }, true);
  });
});
await c.route("**/api/hit", (r) => r.fulfill({ status: 204, body: "" }));                 // the demo is not counted as a visit
const p = await c.newPage();

// ---- capture
const frames = [];
const cdp = await c.newCDPSession(p);
cdp.on("Page.screencastFrame", async (f) => {
  frames.push({ t: f.metadata.timestamp, data: f.data });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch (e) {}
});

let mx = W / 2, my = H / 2;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
async function moveTo(x, y, ms = 700) {
  const x0 = mx, y0 = my, n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) { const k = ease(i / n); await p.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k); await sleep(16); }
  mx = x; my = y;
}
const caption = (html) => p.evaluate((h) => { const e = document.getElementById("demoCap"); if (!h) { e.style.opacity = "0"; return; } e.innerHTML = h; e.style.opacity = "1"; }, html);
const spanPos = (text) => p.evaluate((t) => {
  const s = S.spans[S.doc.pages[0].v].find((x) => x.text.trim() === t), r = pageEl(0).getBoundingClientRect();
  return { x: r.left + (s.tbox[0] + (s.tbox[2] - s.tbox[0]) * 0.55) * S.zoom, y: r.top + (s.tbox[1] + s.tbox[3]) / 2 * S.zoom };
}, text);
async function retype(text, by) {
  const at = await spanPos(text);
  await moveTo(at.x, at.y, 750); await sleep(250);
  await p.mouse.click(at.x, at.y);
  await p.waitForFunction(() => S.ed && document.activeElement === S.ed.box);
  await sleep(450);
  await p.keyboard.press("End"); await sleep(250);
  for (let i = 0; i < text.length; i++) { await p.keyboard.press("Backspace"); await sleep(70); }
  await sleep(200);
  await p.keyboard.type(by, { delay: 135 });
  await sleep(500);
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => !S.ed);
  await sleep(900);
}

await p.goto(B + "/app/");
await p.waitForFunction(() => document.body.classList.contains("engine-ready") && !document.documentElement.classList.contains("i18n-wait"), null, { timeout: 60000 });
await p.mouse.move(mx, my);
await sleep(300);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
await sleep(600);

// 1. open
await caption("Open a PDF &mdash; it never leaves your browser");
await sleep(1100);
const btn = await p.locator("#btnOpen2").boundingBox();
await moveTo(btn.x + btn.width / 2, btn.y + btn.height / 2, 800); await sleep(250);
const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.mouse.click(mx, my)]);
await sleep(350);
await chooser.setFiles(new URL("../fixtures/demo-invoice.pdf", import.meta.url).pathname);
await p.waitForFunction(() => S.doc && pageEl(0).dataset.rkey && S.spans && S.spans[S.doc.pages[0].v], null, { timeout: 30000 });
await caption("Click any text to change it");
await sleep(1500);

// 2. the amount, then the total
await caption("Type the new amount &mdash; <b>same font, same place</b>");
await retype("2,100.00", "2,450.00");
await caption("Fix the total the same way");
await retype("2,520.00", "2,940.00");
await moveTo(mx + 60, my + 90, 500);
await caption("It looks like it was always there");
await sleep(1600);

// 3. download
const dl = await p.locator("#btnDownload").boundingBox();
await caption("Download &mdash; no watermark, nothing uploaded");
await moveTo(dl.x + dl.width / 2, dl.y + dl.height / 2, 900); await sleep(250);
await Promise.all([p.waitForEvent("download"), p.mouse.click(mx, my)]);
await sleep(1200);
await caption("quicktou.ch &mdash; free, open source, 12 languages");
await moveTo(mx + 120, my + 260, 700);
await sleep(2600);

await cdp.send("Page.stopScreencast");
await sleep(300);
frames.forEach((f, i) => fs.writeFileSync(`${OUT}/${String(i).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64")));
fs.writeFileSync(`${OUT}/times.json`, JSON.stringify(frames.map((f) => f.t)));
console.log(`${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s, in ${OUT}`);
await b.close();
