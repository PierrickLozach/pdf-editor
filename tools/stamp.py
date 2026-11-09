"""Version-stamp the web files so browsers never mix an old and a new version after an update.
Run after any change in web/ (the deploy step does it): python3 tools/stamp.py"""
import hashlib, pathlib, re

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
h = hashlib.sha256()
for f in sorted(WEB.rglob("*")):
    if f.is_file() and f.suffix in (".js", ".css", ".wasm", ".json") and "vendor" not in f.parts or f.name == "mupdf-wasm.wasm":
        h.update(f.name.encode()); h.update(re.sub(rb"\?v=[0-9a-f]{10}", b"", f.read_bytes()))
v = h.hexdigest()[:10]

def sub(path, pattern, repl):
    p = WEB / path; s = p.read_text(); n = re.subn(pattern, repl, s); assert n[1] >= 1, (path, pattern); p.write_text(n[0])

sub("index.html", r'href="style\.css(\?v=[0-9a-f]+)?"', f'href="style.css?v={v}"')
sub("index.html", r'src="app\.js(\?v=[0-9a-f]+)?"', f'src="app.js?v={v}"')
sub("index.html", r'src="move\.js(\?v=[0-9a-f]+)?"', f'src="move.js?v={v}"')
sub("index.html", r'src="vault\.js(\?v=[0-9a-f]+)?"', f'src="vault.js?v={v}"')
sub("index.html", r'src="account\.js(\?v=[0-9a-f]+)?"', f'src="account.js?v={v}"')
sub("index.html", r'src="fit\.js(\?v=[0-9a-f]+)?"', f'src="fit.js?v={v}"')
sub("index.html", r'src="i18n\.js(\?v=[0-9a-f]+)?"', f'src="i18n.js?v={v}"')
sub("app.js", r'new Worker\("worker\.js(\?v=[0-9a-f]+)?"', f'new Worker("worker.js?v={v}"')
sub("worker.js", r'from "\./engine\.js(\?v=[0-9a-f]+)?"', f'from "./engine.js?v={v}"')
sub("worker.js", r'"fonts/fonts\.json(\?v=[0-9a-f]+)?"', f'"fonts/fonts.json?v={v}"')
(WEB / "version.txt").write_text(v + "\n")
print("version", v)
