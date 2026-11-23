/* PDF Editor - what the editor keeps in this browser for Word and LibreOffice documents (docs.js), in
 * IndexedDB "pdf-editor-write". Nothing here ever leaves the browser. (Recent files, PDFs and documents
 * alike, are in files.js.)
 *   keep     "recovery" the unsaved copy of the open document, kept while it has changes
 *            "reopen"   the open document while the page reloads in another language
 *            "handoff"  a PDF's text sent by Convert › Edit as a document to a new tab */
(function () {
  "use strict";
  let dbp = null;
  function db() {
    return (dbp = dbp || new Promise((res, rej) => {
      const r = indexedDB.open("pdf-editor-write", 1);
      r.onupgradeneeded = () => { for (const s of ["recent", "keep"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: "id" }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const x = d.transaction(store, mode), st = x.objectStore(store);
      let out;
      const q = fn(st);
      if (q && "onsuccess" in q) q.onsuccess = () => (out = q.result);
      x.oncomplete = () => res(out);
      x.onerror = () => rej(x.error);
      x.onabort = () => rej(x.error);
    });
  }
  const S = (window.DOCSTORE = {
    get: (store, id) => tx(store, "readonly", (st) => st.get(id)).catch(() => undefined),
    all: (store) => tx(store, "readonly", (st) => st.getAll()).then((v) => v || []).catch(() => []),
    put: (store, value) => tx(store, "readwrite", (st) => st.put(value)),
    del: (store, id) => tx(store, "readwrite", (st) => st.delete(id)).catch(() => {}),
    /** read and remove */
    take: async (store, id) => { const v = await S.get(store, id); if (v) await S.del(store, id); return v; },
  });
})();
