/* PDF Editor - the document editor's storage in this browser (IndexedDB "pdf-editor-write"), shared by
 * the PDF editor (/app/) and the document editor (/write/). Nothing here ever leaves the browser.
 *   recent   the Word / LibreOffice files opened with Open or by dropping them (Chrome, Edge): the files
 *            themselves (handles), never copies, so Save writes into them again
 *   keep     "handoff"  a document dropped on the PDF editor, picked up by the document editor
 *            "recovery" the unsaved copy of the open document, kept while it has changes
 *            "reopen"   the open document while the page reloads in another language
 * DOCSTORE.isDoc(name) says whether a file name is a document the document editor opens. */
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
    isDoc: (name) => /\.(docx|dotx|odt|ott)$/i.test(name || ""),
    /** Open a document in the document editor (from the PDF editor): it goes there through this browser's storage. */
    async handOff(file, handle) {
      await S.put("keep", { id: "handoff", file, name: file.name, handle: handle || null, time: Date.now() });
      location.href = "/write/#open";
    },
  });
})();
