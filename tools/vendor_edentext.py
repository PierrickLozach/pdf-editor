"""EdenText, the word processor behind the document editor (/write/), served from this site.

The editor is EdenText's own build, unmodified: the npm package @edentext/app at the version
below. Every site build checks the downloaded package against the SHA-512 the npm registry
publishes for it, then unpacks it into the site; a package that does not match stops the build.
Only two settings files are written next to it (EdenText's documented installation settings):
  embed.config.json     only pages of this site may drive the editor
  edentext.config.json  the AI assistant and dictation are switched off for everyone: they would
                        send the document's text or the voice to another service
Upgrade: change VERSION and INTEGRITY (npm view @edentext/app@<v> dist.integrity), build, run
tests/pw/write.pw.mjs. Licence: AGPL-3.0 with an attribution term (NOTICE.md in the folder);
the source is EdenText's repository at the same version (SOURCE).

Usage: python3 tools/vendor_edentext.py <target folder>   (build_site.py calls it)"""
import base64, hashlib, io, json, pathlib, re, shutil, sys, tarfile, urllib.request

VERSION = "0.15.0"
INTEGRITY = "sha512-ZEoELPfpVWK2pAcs46CVu9d6szPQ0xlchBLRRSEmju7MWeYq73iirgKfzShl3dumV8G/NkUVB6QMKocyuFVi5w=="
URL = f"https://registry.npmjs.org/@edentext/app/-/app-{VERSION}.tgz"
SOURCE = f"https://github.com/stffnb/edentext/tree/v{VERSION}"
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "vendor" / f"edentext-app-{VERSION}.tgz"          # not in git (87 MB unpacked)
MAX_FILE = 25 * 1024 * 1024                                       # Cloudflare's limit per static file


def _check(data):
    algo, want = INTEGRITY.split("-", 1)
    got = base64.b64encode(hashlib.new(algo, data).digest()).decode()
    return got == want


def package():
    """The package's bytes, downloaded once and checked every time."""
    if CACHE.exists():
        data = CACHE.read_bytes()
        if _check(data): return data
        print(f"vendor_edentext: {CACHE.name} does not match its checksum: downloading it again", file=sys.stderr)
    with urllib.request.urlopen(URL, timeout=120) as r: data = r.read()
    if not _check(data): sys.exit(f"vendor_edentext: the package from {URL} does not match {INTEGRITY}: stopped")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(data)
    return data


def install(target):
    """Unpack the editor (package/dist) into target and return the hashes of its inline scripts."""
    target = pathlib.Path(target)
    if target.exists(): shutil.rmtree(target)
    target.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(package()), mode="r:gz") as tar:
        for m in tar.getmembers():
            if not m.isfile() or not m.name.startswith("package/dist/"): continue
            rel = pathlib.PurePosixPath(m.name[len("package/dist/"):])
            if rel.is_absolute() or ".." in rel.parts: sys.exit(f"vendor_edentext: unsafe path {m.name}")
            if m.size > MAX_FILE: sys.exit(f"vendor_edentext: {rel} is larger than 25 MB, which Cloudflare refuses")
            out = target.joinpath(*rel.parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tar.extractfile(m).read())
    for need in ("index.html", "embed.js", "LICENSE", "NOTICE.md", "licenses.txt"):
        if not (target / need).exists(): sys.exit(f"vendor_edentext: {need} missing from the package")
    (target / "embed.config.json").write_text(json.dumps({"origins": ["self"]}, indent=2) + "\n")
    (target / "edentext.config.json").write_text(json.dumps({"ai": {"enabled": False}, "dictation": {"enabled": False}}, indent=2) + "\n")
    (target / "SOURCE.txt").write_text(
        f"EdenText {VERSION} by Steffen Becker, served here unmodified (npm package @edentext/app {VERSION}).\n"
        f"Licence: GNU AGPL v3 with an attribution term, see LICENSE and NOTICE.md in this folder.\n"
        f"Source code: {SOURCE}\nThird-party licences: licenses.txt\n"
        "Settings written by this site: embed.config.json, edentext.config.json (AI assistant and dictation off).\n")
    html = (target / "index.html").read_text()
    m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', html)
    if not m: sys.exit("vendor_edentext: the editor's index.html has no Content-Security-Policy")
    return re.findall(r"'sha256-[A-Za-z0-9+/=]+'", m.group(1))


if __name__ == "__main__":
    if len(sys.argv) != 2: sys.exit(__doc__)
    hashes = install(sys.argv[1])
    print(f"EdenText {VERSION} installed in {sys.argv[1]} (inline scripts: {' '.join(hashes)})")
