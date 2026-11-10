"""Integrity of the third-party files shipped with the site (OWASP A03/A08): the MuPDF engine and
the bundled fonts. "python3 tools/vendor_lock.py --update" records their SHA-256 after a deliberate
upgrade; the site build runs it without --update and stops if any file differs."""
import hashlib, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK = ROOT / "tools" / "vendor.lock.json"
FILES = sorted([p for p in (ROOT / "web" / "vendor").rglob("*") if p.is_file()] +
               [p for p in (ROOT / "web" / "fonts").glob("*.ttf")])
now = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in FILES}
if "--update" in sys.argv:
    LOCK.write_text(json.dumps(now, indent=1) + "\n"); print(f"{len(now)} files recorded in {LOCK.name}"); sys.exit(0)
was = json.loads(LOCK.read_text())
bad = [f for f in sorted(set(was) | set(now)) if was.get(f) != now.get(f)]
if bad:
    print("INTEGRITY CHECK FAILED – these third-party files changed:", *bad, sep="\n  ")
    print("If this upgrade is intended, check the new files, then run: python3 tools/vendor_lock.py --update")
    sys.exit(1)
print(f"third-party files verified ({len(now)})")
