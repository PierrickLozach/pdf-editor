"""Build web/fonts/free-fonts.json: the free fonts (Google Fonts and other open-licence fonts,
served by Fontsource through jsDelivr) the editor can download when a PDF uses one of them.
Run again from time to time to pick up new fonts: python3 tools/build_free_fonts.py"""
import json, pathlib, urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "web" / "fonts" / "free-fonts.json"
OPEN = {"ofl-1.1", "apache-2.0", "ufl-1.0", "mit", "cc0-1.0"}
SUB = ["latin", "latin-ext", "greek", "greek-ext", "cyrillic", "cyrillic-ext", "vietnamese"]
key = lambda s: "".join(c for c in s.lower() if c.isalnum())
req = urllib.request.Request("https://api.fontsource.org/v1/fonts", headers={"User-Agent": "Mozilla/5.0 (pdf-editor font catalogue builder)"})
data = json.load(urllib.request.urlopen(req, timeout=60))
cat = {}
for f in sorted(data, key=lambda f: (f.get("type") != "google", f["family"])):   # Google first on name clashes
    if (f.get("license") or "").lower() not in OPEN or "latin" not in f["subsets"]: continue
    k = key(f["family"])
    if k in cat: continue
    st = (1 if "normal" in f["styles"] else 0) | (2 if "italic" in f["styles"] else 0)
    cat[k] = [f["id"], f["family"], f["weights"], st, [s for s in SUB if s in f["subsets"]]]
# well-known PDF names of fonts that Google publishes under another name
for alias, real in {"sourcesanspro": "sourcesans3", "sourceserifpro": "sourceserif4", "notosansui": "notosans"}.items():
    if alias not in cat and real in cat: cat[alias] = cat[real]
OUT.write_text(json.dumps(cat, separators=(",", ":")))
print(len(cat), "families,", OUT.stat().st_size // 1024, "KB ->", OUT)
