/* PDF Editor - Make searchable (OCR) (uses the globals of app.js and tools.js).
 *  Recognises the text of scanned pages in this browser (Tesseract, served by this site: the pages are
 *  never uploaded) and lays it, invisible, over each page: the PDF can then be searched, copied and
 *  read aloud, and it looks exactly the same. */
(function () {
  "use strict";
  const t = (s) => (window.I18N ? I18N.t(s) : s);
  const esc = (s) => (window.TOOLS ? TOOLS.esc(s) : String(s));
  const OCR = (window.OCR = {});
  // the editor's languages -> Tesseract's models (all served from vendor/tessdata)
  const LANGS = { en: "eng", fr: "fra", es: "spa", pt: "por", de: "deu", nl: "nld", it: "ita", pl: "pol", ar: "ara", he: "heb", zh: "chi_sim", ja: "jpn" };
  const NAMES = { eng: "English", fra: "Français", spa: "Español", por: "Português", deu: "Deutsch", nld: "Nederlands", ita: "Italiano", pol: "Polski", ara: "العربية", heb: "עברית", chi_sim: "简体中文", jpn: "日本語" };
  let lib = null;
  function load() {
    if (lib) return lib;
    lib = new Promise((res, rej) => {
      if (window.Tesseract) return res(window.Tesseract);
      const s = document.createElement("script");
      s.src = new URL("vendor/tesseract/tesseract.min.js", location.href).href;
      s.onload = () => res(window.Tesseract);
      s.onerror = () => { lib = null; rej(new Error(t("The text recognition could not be loaded. Check the connection and try again."))); };
      document.head.appendChild(s);
    });
    return lib;
  }

  OCR.open = async () => {
    if (!S.doc) return;
    const n = S.doc.pages.length;
    const scans = await call("textlessPages");
    const ui = LANGS[(window.I18N && I18N.lang) || "en"] || "eng";
    const opts = Object.entries(NAMES).map(([c, nm]) => `<option value="${c}"${c === ui ? " selected" : ""}>${esc(nm)}</option>`).join("");
    const v = await TOOLS.ask("ocrDlg", t("Make searchable (OCR)"), `
      <p class="small">${esc(scans.length ? (scans.length === n ? t("No page of this PDF has text: it looks scanned.") : t("{k} of {n} pages have no text (scanned).").replace("{k}", scans.length).replace("{n}", n)) : t("Every page already has text. Recognising it again is only useful for poor scans."))}</p>
      <label class="field">${esc(t("Language of the document"))} <select name="lang">${opts}</select></label>
      <label class="field">${esc(t("Second language (optional)"))} <select name="lang2"><option value="">–</option>${opts.replace(/ selected/, "")}</select></label>
      <label class="opt"><input type="radio" name="which" value="scans"${scans.length ? " checked" : " disabled"}> <span>${esc(t("Only the pages without text"))}</span></label>
      <label class="opt"><input type="radio" name="which" value="all"${scans.length ? "" : " checked"}> <span>${esc(t("All pages"))}</span></label>
      <p class="small muted">${esc(t("Done in this browser: the pages are never uploaded. About 2 to 5 seconds per page; the language data (1 to 3 MB) is downloaded once."))}</p>`, t("Recognise text"));
    if (!v) return;
    let pages = v.which === "all" || !scans.length ? [...Array(n).keys()] : scans;
    if (window.PROTOOLS) { pages = await PROTOOLS.ocrPages(pages); if (!pages) return; }      // free: a few pages per PDF
    const langs = [...new Set([v.lang, v.lang2].filter(Boolean))].join("+");
    await closeEditor(true);
    await run(pages, langs);
  };

  async function run(pages, langs) {
    const prog = TOOLS.progress(t("Recognising text…"));
    let worker = null, cancelled = false;
    prog.onCancel(() => { cancelled = true; if (worker) worker.terminate(); });
    try {
      const T = await load();
      const root = new URL("vendor/", location.href).href;
      worker = await T.createWorker(langs, 1, {
        workerPath: root + "tesseract/worker.min.js", corePath: root + "tesseract/core/", langPath: root + "tessdata",
        workerBlobURL: false, gzip: true, cacheMethod: "write",
        logger: (m) => { if (m.status === "recognizing text") prog.step(m.progress); },
      });
      const layers = [];
      for (let i = 0; i < pages.length && !cancelled; i++) {
        prog.set(t("Page {k} of {n}").replace("{k}", i + 1).replace("{n}", pages.length), i / pages.length, 1 / pages.length);
        const png = await call("pagePng", pages[i], 300);
        const r = await worker.recognize(new Blob([png.bytes], { type: "image/png" }), {}, { pdf: true, text: false });
        if (r.data.pdf) layers.push({ page: pages[i], pdf: new Uint8Array(r.data.pdf) });
      }
      if (cancelled) return;
      prog.set(t("Adding the text to the PDF…"), 1, 0);
      const info = await call("addTextLayer", layers);
      applyInfo(info);
      prog.close();
      const found = info.changed.length;
      toast(found ? t("Text recognised on {n} pages: the PDF can now be searched and copied. You can undo it.").replace("{n}", found) : t("No text was found on these pages."), !found, 8000);
    } catch (e) {
      prog.close();
      if (!cancelled) toast(e.message || String(e), true, 8000);
    } finally {
      if (worker && !cancelled) worker.terminate();
    }
  }
})();
