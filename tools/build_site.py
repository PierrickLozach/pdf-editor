"""Build the deployable website in site/public from:
  web/                 the editor                          -> public/app/
  site/pages/<lang>/   one folder of pages per language    -> public/ (default language), public/<lang>/
  site/i18n/<lang>.json  the words of the header and footer
  site/site.json       name, address, publisher, languages
Add a language: see site/DEPLOY.md ("Languages"); python3 tools/check_i18n.py checks a translation.
Usage: python3 tools/build_site.py [--url https://your-domain.com]"""
import datetime, hashlib, html, json, pathlib, re, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB, SITE = ROOT / "web", ROOT / "site"
PUB, PAGES, I18N = SITE / "public", SITE / "pages", SITE / "i18n"

cfg = json.loads((SITE / "site.json").read_text())
if "--url" in sys.argv: cfg["url"] = sys.argv[sys.argv.index("--url") + 1]
cfg["url"] = cfg["url"].rstrip("/")
LANGS = cfg.get("languages", ["en"])
# the editor's list of languages must offer the same ones
_ed = [x["code"] for x in json.loads((WEB / "i18n" / "languages.json").read_text())]
assert set(LANGS) <= set(_ed), f"languages in site.json missing from web/i18n/languages.json: {set(LANGS) - set(_ed)}"
DEFAULT = cfg.get("default_language", LANGS[0])
T = {l: json.loads((I18N / f"{l}.json").read_text()) for l in LANGS}
root_of = lambda l: "/" if l == DEFAULT else f"/{l}/"
url_of = lambda l, slug: root_of(l) + ("" if slug == "index" else slug)

def date_in(l):
    d, t = datetime.date.today(), T[l]
    s = d.strftime(t.get("date_format", "%Y-%m-%d"))
    if t.get("months"): s = s.replace(d.strftime("%B"), t["months"][d.month - 1])
    return s

def fill(text, l):
    vals = {"name": T[l]["site_name"], "root": root_of(l), "updated": date_in(l), "url": cfg["url"], "source": cfg["source"], "host": cfg["host"],
            "publisher.name": cfg["publisher"]["name"], "publisher.address": cfg["publisher"]["address"], "publisher.email": cfg["publisher"]["email"]}
    return re.sub(r"\{\{([a-z.]+)\}\}", lambda m: html.escape(vals[m.group(1)]), text)

# ---------------------------------------------------------------- editor
subprocess.run([sys.executable, str(ROOT / "tools" / "vendor_lock.py")], check=True)        # stops on tampered files
subprocess.run([sys.executable, str(ROOT / "tools" / "stamp.py")], check=True, stdout=subprocess.DEVNULL)
if PUB.exists(): shutil.rmtree(PUB)
shutil.copytree(WEB, PUB / "app", ignore=shutil.ignore_patterns("package.json", "_headers", ".nojekyll", "README.md", ".DS_Store"))
shutil.copytree(PAGES / "assets", PUB / "assets", ignore=shutil.ignore_patterns(".DS_Store"))
# ---------------------------------------------------------------- developer library: /lib/v1/ (stable address for major version 1)
LIB = PUB / "lib" / "v1"
LIB.mkdir(parents=True)
for f in ("lib.js", "engine.js", "fontfile.js"): shutil.copy(WEB / f, LIB / f)
shutil.move(str(LIB / "lib.js"), str(LIB / "pdf-editor.js"))
shutil.copytree(WEB / "fonts", LIB / "fonts", ignore=shutil.ignore_patterns(".DS_Store"))
shutil.copytree(WEB / "vendor" / "mupdf", LIB / "vendor" / "mupdf", ignore=shutil.ignore_patterns(".DS_Store"))
(LIB / "LICENSE.txt").write_text((ROOT / "LICENSE").read_text())
(LIB / "README.txt").write_text(f"PDF Editor library {json.loads((WEB / 'package.json').read_text()).get('version', '')} — AGPL-3.0.\n"
    f"Documentation: {cfg['url']}/developers   Source: {cfg['source']}\n"
    "Text recognition (ocr) in a browser needs the recogniser served from your own site: see the documentation.\n")
shutil.copy(WEB / "icon.png", PUB / "icon.png")
subprocess.run(["sips", "-s", "format", "png", "-z", "48", "48", str(WEB / "icon.png"), "--out", str(PUB / "favicon.ico")], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ver = hashlib.sha256(b"".join(p.read_bytes() for p in sorted((PAGES / "assets").rglob("*")) if p.is_file())).hexdigest()[:10]
GLOBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>'

LAYOUT = """<!doctype html>
<html lang="{lang}" dir="{dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
{robots}<link rel="canonical" href="{url}{path}">
{alternates}
<script src="/assets/lang.js?v={ver}"></script>
<meta property="og:type" content="website">
<meta property="og:site_name" content="{name}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}{path}">
<meta property="og:locale" content="{locale}">
<meta property="og:image" content="{url}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#e5322d">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/assets/site.css?v={ver}">
<script type="module" src="/assets/site.js?v={ver}"></script>
</head>
<body data-page="{page}">
<a class="skip" href="#main">{t_skip}</a>
<header class="site-header"><div class="wrap">
  <a class="brand" href="{root}"><span class="logo">P</span>{name}</a>
  <nav class="site-nav" aria-label="{t_nav_editor}">
    <a href="/app/">{t_nav_editor}</a><a href="{root}#features">{t_nav_features}</a><a href="{root}#privacy">{t_nav_privacy}</a><a href="{root}#faq">{t_nav_faq}</a>
  </nav>
  <div id="userArea">
    <label class="lang-switch">{globe}<span class="visually-hidden">{t_language}</span><select id="langSwitch">{options}</select></label>
    <a class="btn primary" href="/app/">{t_open_editor}</a>
  </div>
</div></header>
{body}
<footer class="site-footer"><div class="wrap">
  <nav aria-label="{t_footer_legal}">
    <a href="/app/">{t_nav_editor}</a><a href="{root}privacy">{t_footer_privacy}</a><a href="{root}cookies">{t_footer_cookies}</a><a href="{root}terms">{t_footer_terms}</a><a href="{root}legal">{t_footer_legal}</a><a href="/developers" lang="en">{t_footer_developers}</a><a href="{source}">{t_footer_source}</a>
  </nav>
  <span class="copy">© <span id="year"></span> {publisher} · {t_footer_free}</span>
</div></footer>
</body>
</html>
"""

ENGLISH_ONLY = {"developers"}                     # pages for developers: in English, at one address
slugs = sorted(p.stem for p in (PAGES / DEFAULT).glob("*.html"))
sitemap = []
for l in LANGS:
    out = PUB if l == DEFAULT else PUB / l
    out.mkdir(parents=True, exist_ok=True)
    for slug in slugs:
        if slug in ENGLISH_ONLY and l != DEFAULT: continue
        src = PAGES / l / f"{slug}.html"
        if not src.exists(): src = PAGES / DEFAULT / f"{slug}.html"      # not translated yet: default language
        raw = src.read_text()
        m = re.match(r"\s*<!--(.*?)-->\s*", raw, re.S)
        meta = dict(re.findall(r"^\s*([a-z]+):\s*(.*?)\s*$", m.group(1), re.M)) if m else {}
        body = raw[m.end():] if m else raw
        path = url_of(l, slug)
        alts = [DEFAULT] if slug in ENGLISH_ONLY else LANGS
        alternates = "\n".join(f'<link rel="alternate" hreflang="{x}" href="{cfg["url"]}{url_of(x, slug)}">' for x in alts)
        alternates += f'\n<link rel="alternate" hreflang="x-default" href="{cfg["url"]}{url_of(DEFAULT, slug)}">'
        options = f'<option value="auto">{html.escape(T[l].get("language_auto", "Browser language"))}</option>' + \
                  "".join(f'<option value="{x}" data-href="{url_of(x, "index" if slug in ENGLISH_ONLY and x != DEFAULT else slug)}"{" selected" if x == l else ""}>{html.escape(T[x]["name"])}</option>' for x in LANGS)
        words = {f"t_{k}": html.escape(v) for k, v in T[l].items() if isinstance(v, str)}
        page = LAYOUT.format(lang=l, dir=T[l].get("dir", "ltr"), title=fill(meta.get("title", T[l]["site_name"]), l),
                             description=fill(meta.get("description", ""), l), robots='<meta name="robots" content="noindex">\n' if meta.get("noindex") else "",
                             url=cfg["url"], path=path, alternates=alternates, ver=ver, name=html.escape(T[l]["site_name"]), locale=T[l].get("locale", l),
                             page=slug, root=root_of(l), globe=GLOBE, options=options, body=fill(body, l), source=html.escape(cfg["source"]),
                             publisher=html.escape(cfg["publisher"]["name"]), **words)
        page = page.replace('src="/assets/editor.webp"', f'src="/assets/editor.webp?v={ver}"')
        (out / f"{slug}.html").write_text(page)
        if slug != "404" and not meta.get("noindex"): sitemap.append(path)

# ---------------------------------------------------------------- site files
(PUB / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {cfg['url']}/sitemap.xml\n")
today = datetime.date.today().isoformat()
(PUB / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    "".join(f"  <url><loc>{cfg['url']}{p}</loc><lastmod>{today}</lastmod></url>\n" for p in sitemap + ["/app/"]) + "</urlset>\n")
(PUB / "manifest.webmanifest").write_text(json.dumps({
    "name": T[DEFAULT]["site_name"], "short_name": T[DEFAULT]["site_name"], "description": cfg["description"], "start_url": "/app/", "scope": "/",
    "display": "standalone", "background_color": "#ffffff", "theme_color": "#e5322d",
    "icons": [{"src": "/icon.png", "sizes": "1024x1024", "type": "image/png", "purpose": "any"}],
}, indent=1))

# Security headers (OWASP A02). "/*" covers everything, 404 pages and files included; the editor
# (/app/*) replaces the Content-Security-Policy with its own (it needs WebAssembly and the font CDN).
SITE_CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
APP_CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
           "font-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net/fontsource/fonts/; object-src 'none'; base-uri 'none'; "
           "form-action 'none'; frame-ancestors 'none'")
common = ("  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n"
          "  Strict-Transport-Security: max-age=63072000; includeSubDomains\n"
          "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=(), local-fonts=(self)\n"
          "  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Resource-Policy: same-origin\n  X-Permitted-Cross-Domain-Policies: none\n")
rules = [f"/*\n  Content-Security-Policy: {SITE_CSP}\n{common}"]
rules.append(f"/app/*\n  ! Content-Security-Policy\n  Content-Security-Policy: {APP_CSP}\n")
rules.append("/app/vendor/*\n  Cache-Control: public, max-age=31536000, immutable\n")
rules.append("/app/fonts/*.ttf\n  Cache-Control: public, max-age=31536000, immutable\n")
rules.append("/assets/*\n  Cache-Control: public, max-age=86400\n")
rules.append("/.well-known/*\n  Content-Type: text/plain; charset=utf-8\n")
# the library can be used from other websites: its files only (code, WebAssembly engine, fonts), read-only
rules.append("/lib/*\n  ! Cross-Origin-Resource-Policy\n  Cross-Origin-Resource-Policy: cross-origin\n  Access-Control-Allow-Origin: *\n"
             "  Cache-Control: public, max-age=3600\n")
rules.append("/lib/v1/vendor/*\n  Cache-Control: public, max-age=31536000, immutable\n")
rules.append("/lib/v1/fonts/*.ttf\n  Cache-Control: public, max-age=31536000, immutable\n")
# how to report a security problem (RFC 9116)
wk = PUB / ".well-known"; wk.mkdir(exist_ok=True)
expires = (datetime.date.today() + datetime.timedelta(days=330)).isoformat() + "T00:00:00Z"
(wk / "security.txt").write_text(f"Contact: {cfg['source']}/security/advisories/new\nExpires: {expires}\n"
    f"Preferred-Languages: en, fr\nCanonical: {cfg['url']}/.well-known/security.txt\nPolicy: {cfg['source']}/blob/main/SECURITY.md\n")
(PUB / "_headers").write_text("# Generated by tools/build_site.py\n" + "\n".join(rules))

todo = [k for k in ("address", "email") if cfg["publisher"][k].startswith("[")]
n = sum(1 for p in PUB.rglob("*") if p.is_file())
print(f"site built in {PUB} ({n} files, languages: {', '.join(LANGS)}) for {cfg['url']}")
if todo: print("NOTE: fill in site/site.json before going live: publisher " + ", ".join(todo))
