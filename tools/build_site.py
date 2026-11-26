"""Build the deployable website in site/public from:
  web/                 the editor                          -> public/app/
  EdenText (Word and LibreOffice documents)       -> public/app/edentext/ (tools/vendor_edentext.py)
  site/pages/<lang>/   one folder of pages per language    -> public/ (default language), public/<lang>/
  site/i18n/<lang>.json  the words of the header and footer
  site/site.json       name, publisher (name, contact email), host, languages
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

def date_in(l, d=None):
    d, t = d or datetime.date.today(), T[l]
    s = d.strftime(t.get("date_format", "%Y-%m-%d"))
    if t.get("months"): s = s.replace(d.strftime("%B"), t["months"][d.month - 1])
    return s

def seller():
    """The business that sells Pro: the registered business once site.json says so, else the publisher."""
    b = cfg.get("business", {})
    if b.get("registered"):
        return {"name": b["name"], "status": b.get("status", ""), "siret": b["siret"], "address": b["address"], "email": b["email"],
                "mediator": b["mediator"] + (" – " + b["mediator_url"] if b.get("mediator_url") else ""), "vat": b.get("vat", "")}
    return {"name": cfg["publisher"]["name"], "status": "", "siret": "", "address": "", "email": cfg["publisher"]["email"],
            "mediator": "(désigné à l'ouverture de la boutique)", "vat": ""}

PRO_VISIBLE = bool(cfg.get("pro", {}).get("visible"))
# Ads: on once an AdSense publisher id is set in site.json (ads.client = "ca-pub-…"); the pages switch with <!-- ads:on/off -->
ADS = cfg.get("ads", {})
import os
if os.environ.get("PDFE_ADS_CLIENT"): ADS = {**ADS, "client": os.environ["PDFE_ADS_CLIENT"], "slot": os.environ.get("PDFE_ADS_SLOT", ""), "consent": os.environ.get("PDFE_ADS_CONSENT", ADS.get("consent", "open-source"))}   # tests only
# two steps: the publisher id alone = AdSense site verification only (ads.txt + a meta tag; nothing loaded, no cookie,
# pages unchanged); the publisher id and an ad slot = the ad is served, with the consent banner and the ad wording
ADS_VERIFY = bool(ADS.get("client"))
ADS_ON = ADS_VERIFY and bool(ADS.get("slot"))
ADS_MODE = ADS.get("consent", "open-source")
if ADS_VERIFY and not re.fullmatch(r"ca-pub-\d{10,20}", ADS["client"]): sys.exit("site.json: ads.client must look like ca-pub-1234567890123456")
if ADS_VERIFY and ADS_MODE not in ("open-source", "google"): sys.exit('site.json: ads.consent must be "open-source" or "google"')
if ADS_ON and not re.fullmatch(r"\d{6,20}", str(ADS["slot"])): sys.exit("site.json: ads.slot must be the ad unit's number (data-ad-slot)")
ADS_TEXT = json.loads((ROOT / "site" / "i18n" / "ads.json").read_text())

def blocks(text):
    """<!-- pro:on --> … <!-- /pro:on --> is kept only while Pro is shown on the site (site.json pro.visible), pro:off the
    opposite; then <!-- business:on --> … is kept only once the business is registered, business:off the opposite."""
    text = re.sub(r"[ \t]*<!-- pro:(on|off) -->\n?(.*?)[ \t]*<!-- /pro:\1 -->\n?", lambda m: m.group(2) if (m.group(1) == "on") == PRO_VISIBLE else "", text, flags=re.S)
    on = bool(cfg.get("business", {}).get("registered"))
    text = re.sub(r"[ \t]*<!-- business:(on|off) -->\n?(.*?)[ \t]*<!-- /business:\1 -->\n?", lambda m: m.group(2) if (m.group(1) == "on") == on else "", text, flags=re.S)
    text = re.sub(r"[ \t]*<!-- ads:(on|off) -->\n?(.*?)[ \t]*<!-- /ads:\1 -->\n?", lambda m: m.group(2) if (m.group(1) == "on") == ADS_ON else "", text, flags=re.S)
    text = re.sub(r"<!-- consent:(open-source|google) -->(.*?)<!-- /consent:\1 -->", lambda m: m.group(2) if m.group(1) == ADS_MODE else "", text, flags=re.S)
    return text

def ads_head(l):
    if not ADS_VERIFY: return ""
    meta = f'<meta name="google-adsense-account" content="{ADS["client"]}">\n'      # AdSense site verification: loads nothing
    if not ADS_ON: return meta
    if ADS_MODE == "google":                              # Google's certified consent message, set up in AdSense › Privacy & messaging
        return meta + f'<script src="/assets/ads.js?v={ver}" defer data-client="{ADS["client"]}" data-mode="google" data-home="{root_of(l)}"></script>\n'
    return meta + (f'<link rel="stylesheet" href="/assets/vendor/cookieconsent/cookieconsent.css?v={ver}">\n'
            f'<script src="/assets/vendor/cookieconsent/cookieconsent.umd.js?v={ver}" defer></script>\n'
            f'<script src="/assets/ads.js?v={ver}" defer data-client="{ADS["client"]}" data-mode="open-source"></script>\n')

def page_info(slug):
    """A page's header comment (title, description, langs, type, published) read from its English version."""
    raw = (PAGES / DEFAULT / f"{slug}.html").read_text()
    m = re.match(r"\s*<!--(.*?)-->\s*", raw, re.S)
    return dict(re.findall(r"^\s*([a-z]+):\s*(.*?)\s*$", m.group(1), re.M)) if m else {}

def langs_of(slug):
    """The languages a page exists in: 'langs: en, fr' in its header, else every language."""
    v = page_info(slug).get("langs") if (PAGES / DEFAULT / f"{slug}.html").exists() else None
    return [x.strip() for x in v.split(",") if x.strip() in LANGS] if v else list(LANGS)

def local_root(l, slug):
    """The root to link to a page from language l: its own when the page exists in l, else the default language's."""
    return root_of(l) if l in langs_of(slug) else root_of(DEFAULT)

def _text(h):
    """Plain text of an HTML fragment."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()

# schema.org type of each page that is not an article (articles: "type: article" in the page's header)
PAGE_TYPE = {"about": "AboutPage", "contact": "ContactPage", "guides": "CollectionPage", "whats-new": "WebPage",
             "privacy": "WebPage", "cookies": "WebPage", "terms": "WebPage", "legal": "WebPage", "sales": "WebPage", "developers": "WebPage"}

def jsonld(l, slug, meta, path, body=""):
    """Structured data (schema.org JSON-LD) for every page: the site, its publisher and the editor on the home page
    (with its questions as an FAQPage), an Article on guides, the right WebPage type elsewhere, and a breadcrumb."""
    if slug == "404": return ""
    url, name, pub = cfg["url"], T[l]["site_name"], cfg["publisher"]["name"]
    org_id, site_id, app_id = url + "/#organization", url + "/#website", url + "/#editor"
    author = {"@type": "Person", "name": pub, "url": url + url_of(DEFAULT if l not in langs_of("about") else l, "about")}
    org = {"@type": "Organization", "@id": org_id, "name": name, "url": url + "/", "logo": {"@type": "ImageObject", "url": url + "/icon.png"},
           "email": cfg["publisher"]["email"], "founder": author, "sameAs": [cfg["source"]],
           "contactPoint": {"@type": "ContactPoint", "contactType": "customer support", "email": cfg["publisher"]["email"],
                            "url": url + url_of(l, "contact"), "availableLanguage": ["en", "fr"]}}
    title = re.sub(r"\s+–\s+[^–]*$", "", fill(meta.get("title", ""), l, raw=True)) if meta.get("title", "").rstrip().endswith("{{name}}") else fill(meta.get("title", ""), l, raw=True)
    desc = fill(meta.get("description", ""), l, raw=True)
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    crumb = _text(h1.group(1)) if h1 else title
    home = {"@type": "ListItem", "position": 1, "name": name, "item": url + root_of(l)}
    items = []
    if slug == "index":
        items.append({"@context": "https://schema.org", **org})
        items.append({"@context": "https://schema.org", "@type": "WebSite", "@id": site_id, "name": name, "url": url + root_of(l),
                      "description": desc, "inLanguage": l, "publisher": {"@id": org_id}})
        items.append({"@context": "https://schema.org", "@type": "WebApplication", "@id": app_id, "name": name, "url": url + "/app/",
                      "description": desc, "applicationCategory": "UtilitiesApplication",
                      "operatingSystem": "Any (web browser)", "browserRequirements": "Chrome, Edge, Firefox or Safari",
                      "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"}, "isAccessibleForFree": True,
                      "inLanguage": LANGS, "author": author, "publisher": {"@id": org_id}, "image": url + "/assets/og.png",
                      "screenshot": url + "/assets/editor.webp", "license": cfg["source"] + "/blob/main/LICENSE"})
        qa = [{"@type": "Question", "name": _text(q), "acceptedAnswer": {"@type": "Answer", "text": _text(a)}}
              for q, a in re.findall(r"<details>\s*<summary>(.*?)</summary>\s*(.*?)</details>", body, re.S)]
        faq_h = re.search(r'id="faq".*?<h2[^>]*>(.*?)</h2>', body, re.S)
        if qa: items.append({"@context": "https://schema.org", "@type": "FAQPage", "name": _text(faq_h.group(1)) + " – " + name if faq_h else name,
                             "inLanguage": l, "url": url + path + "#faq", "mainEntity": qa})
        return "".join('<script type="application/ld+json">' + json.dumps(x, ensure_ascii=False).replace("</", "<\\/") + "</script>\n" for x in items)
    site_ref = {"@type": "WebSite", "@id": site_id, "name": name, "url": url + root_of(l)}
    if meta.get("type") == "article":
        items.append({"@context": "https://schema.org", "@type": "Article", "headline": title,
                      "description": desc, "inLanguage": l, "author": author,
                      "publisher": {"@type": "Organization", "@id": org_id, "name": name, "logo": {"@type": "ImageObject", "url": url + "/icon.png"}},
                      "datePublished": meta.get("published", ""), "dateModified": meta.get("modified", meta.get("published", "")),
                      "image": url + meta.get("image", "/assets/og.png"), "mainEntityOfPage": url + path, "isPartOf": site_ref})
        g = local_root(l, "guides")
        crumbs = [home, {"@type": "ListItem", "position": 2, "name": T[l].get("nav_guides", "Guides"), "item": url + g + "guides"},
                  {"@type": "ListItem", "position": 3, "name": title, "item": url + path}]
    else:
        page = {"@context": "https://schema.org", "@type": PAGE_TYPE.get(slug, "WebPage"), "@id": url + path, "url": url + path,
                "name": title, "description": desc, "inLanguage": l, "isPartOf": site_ref, "publisher": {"@type": "Organization", "@id": org_id, "name": name}}
        if meta.get("published"): page["datePublished"] = meta["published"]
        if meta.get("modified") or meta.get("published"): page["dateModified"] = meta.get("modified", meta.get("published"))
        if slug == "about": page["mainEntity"] = author
        if slug == "contact": page["mainEntity"] = {k: v for k, v in org.items() if k != "founder"}
        if slug == "guides":
            arts = [x for x in sorted(p.stem for p in (PAGES / DEFAULT).glob("*.html")) if page_info(x).get("type") == "article" and l in langs_of(x)]
            page["mainEntity"] = {"@type": "ItemList", "itemListElement": [
                {"@type": "ListItem", "position": i + 1, "url": url + url_of(l, x),
                 "name": re.sub(r"\s+–\s+[^–]*$", "", fill(_meta_of(l, x).get("title", ""), l, raw=True))} for i, x in enumerate(arts)]}
        items.append(page)
        if slug == "developers":
            items.append({"@context": "https://schema.org", "@type": "SoftwareSourceCode", "name": name + " library",
                          "description": desc, "codeRepository": cfg["source"], "programmingLanguage": "JavaScript",
                          "runtimePlatform": ["Web browser", "Node.js"], "license": cfg["source"] + "/blob/main/LICENSE",
                          "url": url + path, "author": author, "isAccessibleForFree": True})
        crumbs = [home, {"@type": "ListItem", "position": 2, "name": crumb, "item": url + path}]
    items.append({"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": crumbs})
    return "".join('<script type="application/ld+json">' + json.dumps(x, ensure_ascii=False).replace("</", "<\\/") + "</script>\n" for x in items)

def _meta_of(l, slug):
    """A page's header in language l (the default language's when it is not translated)."""
    src = PAGES / l / f"{slug}.html"
    if not src.exists(): src = PAGES / DEFAULT / f"{slug}.html"
    m = re.match(r"\s*<!--(.*?)-->\s*", src.read_text(), re.S)
    return dict(re.findall(r"^\s*([a-z]+):\s*(.*?)\s*$", m.group(1), re.M)) if m else {}

def fill(text, l, raw=False):
    vals = {"name": T[l]["site_name"], "root": root_of(l), "updated": date_in(l), "url": cfg["url"], "source": cfg["source"], "host": cfg["host"],
            "guidesroot": local_root(l, "guides"),
            "publisher.name": cfg["publisher"]["name"], "publisher.email": cfg["publisher"]["email"],
            **{"seller." + k: str(v) for k, v in seller().items()}}
    return re.sub(r"\{\{([a-z.]+)\}\}", lambda m: vals[m.group(1)] if raw else html.escape(vals[m.group(1)]), text if raw else blocks(text))

# ---------------------------------------------------------------- editor
subprocess.run([sys.executable, str(ROOT / "tools" / "vendor_lock.py")], check=True)        # stops on tampered files
subprocess.run([sys.executable, str(ROOT / "tools" / "stamp.py")], check=True, stdout=subprocess.DEVNULL)
if PUB.exists(): shutil.rmtree(PUB)
shutil.copytree(WEB, PUB / "app", ignore=shutil.ignore_patterns("package.json", "_headers", ".nojekyll", "README.md", ".DS_Store"))
subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("build_promo_subtitles.py"))], check=True)
shutil.copytree(PAGES / "assets", PUB / "assets", ignore=shutil.ignore_patterns(".DS_Store"))
# ---------------------------------------------------------------- developer library: /lib/v1/ (stable address for major version 1)
LIB = PUB / "lib" / "v1"
LIB.mkdir(parents=True)
for f in ("lib.js", "engine.js", "fontfile.js"): shutil.copy(WEB / f, LIB / f)
shutil.move(str(LIB / "lib.js"), str(LIB / "pdf-editor.js"))
shutil.copytree(WEB / "fonts", LIB / "fonts", ignore=shutil.ignore_patterns(".DS_Store"))
shutil.copytree(WEB / "vendor" / "mupdf", LIB / "vendor" / "mupdf", ignore=shutil.ignore_patterns(".DS_Store"))
(LIB / "LICENSE.txt").write_text((ROOT / "LICENSE").read_text())
# Pro: is the publisher's business registered? (the admin page refuses to open the shop otherwise)
BIZ = cfg.get("business", {})
if BIZ.get("registered"):
    missing = [k for k in ("name", "siret", "address", "email", "mediator") if not str(BIZ.get(k, "")).strip() or "example" in str(BIZ.get(k, "")).lower()]
    if missing: sys.exit("site.json: business.registered is true but these are missing: " + ", ".join(missing))
(PUB / "app" / "pro-site.json").write_text(json.dumps({"registered": bool(BIZ.get("registered")), "visible": PRO_VISIBLE}) + "\n")
(LIB / "LICENSING.txt").write_text((ROOT / "LICENSING.md").read_text())
(LIB / "README.txt").write_text(f"Quicktou.ch library {json.loads((WEB / 'package.json').read_text()).get('version', '')} — AGPL-3.0, or a commercial licence (see LICENSING.txt).\n"
    f"Documentation: {cfg['url']}/developers   Source: {cfg['source']}\n"
    "Text recognition (ocr) in a browser needs the recogniser served from your own site: see the documentation.\n")
shutil.copy(WEB / "icon.png", PUB / "icon.png")
subprocess.run(["sips", "-s", "format", "png", "-z", "48", "48", str(WEB / "icon.png"), "--out", str(PUB / "favicon.ico")], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ver = hashlib.sha256(b"".join(p.read_bytes() for p in sorted((PAGES / "assets").rglob("*")) if p.is_file())).hexdigest()[:10]
# ---------------------------------------------------------------- Word and LibreOffice documents: EdenText, unmodified, in /app/edentext/ (web/docs.js shows it)
sys.path.insert(0, str(ROOT / "tools"))
import vendor_edentext
EDT_HASHES = vendor_edentext.install(PUB / "app" / "edentext")      # stops when the package does not match its checksum
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
<meta property="og:type" content="{ogtype}">
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
<script src="/assets/stats.js?v={ver}" defer></script>
{jsonld}{ads_head}</head>
<body data-page="{page}">
<a class="skip" href="#main">{t_skip}</a>
<header class="site-header"><div class="wrap">
  <a class="brand" href="{root}"><span class="logo">Q</span>{name}</a>
  <nav class="site-nav" aria-label="{t_nav_editor}">
    <a href="/app/">{t_nav_editor}</a><a href="{root}#features">{t_nav_features}</a><a href="{guidesroot}guides">{t_nav_guides}</a><a href="{root}about">{t_nav_about}</a><a href="{root}#faq">{t_nav_faq}</a>
  </nav>
  <div id="userArea">
    <a class="gh-link" href="{source}" target="_blank" rel="noopener" title="{t_github}" aria-label="{t_github}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>
    <label class="lang-switch">{globe}<span class="visually-hidden">{t_language}</span><select id="langSwitch">{options}</select></label>
    <a class="btn primary" href="/app/">{t_open_editor}</a>
  </div>
</div></header>
{body}
<footer class="site-footer"><div class="wrap">
  <nav aria-label="{t_footer_legal}">
    <a href="/app/">{t_nav_editor}</a><a href="{root}about">{t_footer_about}</a><a href="{root}contact">{t_footer_contact}</a><a href="{guidesroot}guides">{t_footer_guides}</a><a href="{guidesroot}whats-new">{t_footer_whatsnew}</a><a href="{root}privacy">{t_footer_privacy}</a><a href="{root}cookies">{t_footer_cookies}</a><a href="{root}terms">{t_footer_terms}</a>{sales_link}<a href="{root}legal">{t_footer_legal}</a>{ads_settings}<a href="/developers" lang="en">{t_footer_developers}</a><a href="{source}">{t_footer_source}</a>
  </nav>
  <span class="copy">© <span id="year"></span> {publisher} · {t_footer_free}</span>
</div></footer>
</body>
</html>
"""

BYLINE = {"en": "By {author} · Updated {date}", "fr": "Par {author} · Mis à jour le {date}"}
slugs = sorted(p.stem for p in (PAGES / DEFAULT).glob("*.html"))
# the visit counter (site/worker/index.js) only counts the pages the site really has: their list, kept in step here
_counted = sorted(set(x for x in slugs if x != "404") | {"app"})
(ROOT / "site" / "worker" / "pages.gen.js").write_text(
    "// Generated by tools/build_site.py: the pages the visit counter accepts (\"\" is the home page). Do not edit.\n"
    f"export const PAGES = new Set({json.dumps([''] + [x for x in _counted if x != 'index'])});\n"
    f"export const PAGE_LANGS = {json.dumps({x: langs_of(x) for x in _counted if x not in ('index', 'app')}, ensure_ascii=False)};\n")
ONLY = {s: langs_of(s) for s in slugs}                # e.g. developers: English; guides: English and French
if not PRO_VISIBLE: slugs.remove("sales")                    # Pro hidden: no terms of sale page
sitemap = []
TITLES = {}
for l in LANGS:
    out = PUB if l == DEFAULT else PUB / l
    out.mkdir(parents=True, exist_ok=True)
    for slug in slugs:
        if l not in ONLY[slug]: continue
        src = PAGES / l / f"{slug}.html"
        if not src.exists(): src = PAGES / DEFAULT / f"{slug}.html"      # not translated yet: default language
        raw = src.read_text()
        m = re.match(r"\s*<!--(.*?)-->\s*", raw, re.S)
        meta = dict(re.findall(r"^\s*([a-z]+):\s*(.*?)\s*$", m.group(1), re.M)) if m else {}
        body = raw[m.end():] if m else raw
        path = url_of(l, slug)
        alts = ONLY[slug]
        alternates = "\n".join(f'<link rel="alternate" hreflang="{x}" href="{cfg["url"]}{url_of(x, slug)}">' for x in alts)
        alternates += f'\n<link rel="alternate" hreflang="x-default" href="{cfg["url"]}{url_of(DEFAULT, slug)}">'
        options = f'<option value="auto">{html.escape(T[l].get("language_auto", "Browser language"))}</option>' + \
                  "".join(f'<option value="{x}" data-href="{url_of(x, slug if x in ONLY[slug] else "index")}"{" selected" if x == l else ""}>{html.escape(T[x]["name"])}</option>' for x in LANGS)
        words = {f"t_{k}": html.escape(v) for k, v in T[l].items() if isinstance(v, str)}
        filled = fill(body, l)
        if meta.get("type") == "article":                 # guides: who wrote it and when it was last checked, under the title
            when = datetime.date.fromisoformat(meta.get("modified") or meta["published"])
            by = BYLINE.get(l, BYLINE[DEFAULT]).format(author=f'<a href="{root_of(l if l in langs_of("about") else DEFAULT)}about">{html.escape(cfg["publisher"]["name"])}</a>',
                                                       date=f'<time datetime="{when.isoformat()}">{html.escape(date_in(l, when))}</time>')
            filled = re.sub(r"(</h1>)", lambda m: m.group(1) + f'\n  <p class="byline">{by}</p>', filled, count=1)
        page = LAYOUT.format(lang=l, dir=T[l].get("dir", "ltr"), title=fill(meta.get("title", T[l]["site_name"]), l),
                             description=fill(meta.get("description", ""), l), robots='<meta name="robots" content="noindex">\n' if meta.get("noindex") else "",
                             url=cfg["url"], path=path, alternates=alternates, ver=ver, name=html.escape(T[l]["site_name"]), locale=T[l].get("locale", l),
                             page=slug, root=root_of(l), globe=GLOBE, options=options, body=filled, source=html.escape(cfg["source"]),
                             publisher=html.escape(cfg["publisher"]["name"]),
                             sales_link=f'<a href="{root_of(l)}sales">{words["t_footer_sales"]}</a>' if PRO_VISIBLE else "",
                             ads_head=ads_head(l), jsonld=jsonld(l, slug, meta, path, filled), ogtype="article" if meta.get("type") == "article" else "website",
                             guidesroot=local_root(l, "guides"), ads_settings=f'<a href="{root_of(l)}cookies" id="ccSettings">{html.escape(ADS_TEXT[l]["cookie_settings"])}</a>' if ADS_ON else "", **words)
        if ADS_ON and slug == "index":                    # the one ad: on the home page, between the toolbox and the developers section
            ad = (f'<aside class="ad-slot wrap" aria-label="{html.escape(ADS_TEXT[l]["ad_label"])}"><p class="ad-label">{html.escape(ADS_TEXT[l]["ad_label"])}</p>'
                  f'<ins class="adsbygoogle" style="display:block" data-ad-client="{ADS["client"]}" data-ad-slot="{html.escape(ADS.get("slot", ""))}" data-ad-format="auto" data-full-width-responsive="true"></ins></aside>\n')
            i = page.find('<section class="wrap" id="developers"')
            if i < 0: i = page.find('id="developers"'); i = page.rfind("<section", 0, i)
            page = page[:i] + ad + page[i:]
        page = re.sub(r'(<nav class="site-nav"[^>]*>.*?</nav>)', lambda m: m.group(1).replace(f'<a href="{path}">', f'<a href="{path}" aria-current="page">'), page, count=1, flags=re.S)
        page = page.replace('src="/assets/editor.webp"', f'src="/assets/editor.webp?v={ver}"')
        page = page.replace('src="/assets/demo.gif"', f'src="/assets/demo.gif?v={ver}"')
        page = page.replace('src="/assets/promo.mp4" poster="/assets/promo-poster.webp"', f'src="/assets/promo.mp4?v={ver}" poster="/assets/promo-poster.webp?v={ver}"')
        page = re.sub(r'src="(/assets/promo/[a-z]+\.vtt)"', lambda m: f'src="{m.group(1)}?v={ver}"', page)
        page = page.replace('src="/assets/documents.webp"', f'src="/assets/documents.webp?v={ver}"')
        page = re.sub(r'src="(/assets/guides/[a-z-]+\.webp)"', lambda m: f'src="{m.group(1)}?v={ver}"', page)
        (out / f"{slug}.html").write_text(page)
        if slug != "404" and not meta.get("noindex"):        # SEO checks: one title per page, structured data everywhere
            t = re.search(r"<title>(.*?)</title>", page, re.S).group(1)
            if t in TITLES: sys.exit(f"duplicate title on {path} and {TITLES[t]}: {html.unescape(t)} (every indexable page needs its own)")
            TITLES[t] = path
            if "application/ld+json" not in page: sys.exit(f"{path}: no JSON-LD structured data")
        if slug != "404" and not meta.get("noindex"): sitemap.append((path, meta.get("modified") or meta.get("published") or datetime.date.today().isoformat()))

# ---------------------------------------------------------------- the editor's structured data (/app/ is in the sitemap)
_app = PUB / "app" / "index.html"
_ld = {"@context": "https://schema.org", "@type": "WebApplication", "@id": cfg["url"] + "/#editor", "name": T[DEFAULT]["site_name"],
       "url": cfg["url"] + "/app/", "description": cfg["description"], "applicationCategory": "UtilitiesApplication",
       "operatingSystem": "Any (web browser)", "browserRequirements": "Chrome, Edge, Firefox or Safari",
       "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"}, "isAccessibleForFree": True, "inLanguage": LANGS,
       "publisher": {"@type": "Organization", "@id": cfg["url"] + "/#organization", "name": T[DEFAULT]["site_name"], "url": cfg["url"] + "/"},
       "screenshot": cfg["url"] + "/assets/editor.webp", "license": cfg["source"] + "/blob/main/LICENSE"}
_html = _app.read_text()
assert "</head>" in _html and "application/ld+json" not in _html
_app.write_text(_html.replace("</head>", '<script type="application/ld+json">' + json.dumps(_ld, ensure_ascii=False).replace("</", "<\\/") + "</script>\n</head>", 1))

# ---------------------------------------------------------------- site files
if ADS_VERIFY: (PUB / "ads.txt").write_text(f"google.com, {ADS['client'].replace('ca-', '')}, DIRECT, f08c47fec0942fa0\n")   # AdSense requires it at the site's root
if ADS_ON:   # the banner's texts per language
    (PUB / "assets" / "consent").mkdir(parents=True, exist_ok=True)
    for l in LANGS:
        t = {k: v.replace("{root}", root_of(l)).replace("href='", 'href="').replace("'>", '">') for k, v in ADS_TEXT[l].items() if k[:2] in ("b_", "p_") or k in ("nec_title", "nec_desc", "ads_title", "ads_desc")}
        (PUB / "assets" / "consent" / f"{l}.json").write_text(json.dumps(t, ensure_ascii=False))
(PUB / "robots.txt").write_text(f"""# {cfg['url']}/robots.txt
#
# Search engines are welcome. Not indexed: the editor's engine, fonts and text-recognition
# data (large binary files), the counter, the private pages and the developer library.
# Content signals (contentsignals.org): search=yes, ai-train=no, use=reference, i.e. index,
# excerpt and link, but no AI training and no reproduction: a reservation of rights under
# Article 4 of EU Directive 2019/790.

User-agent: *
Disallow: /app/vendor/
Disallow: /app/fonts/
Disallow: /app/*.js$
Disallow: /app/*.json$
Disallow: /app/*.wasm$
Disallow: /app/edentext/
Disallow: /api/
Disallow: /lib/
Content-signal: search=yes, ai-train=no, use=reference

User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: CCBot
User-agent: Bytespider
User-agent: Amazonbot
User-agent: Applebot-Extended
User-agent: meta-externalagent
User-agent: PerplexityBot
Disallow: /

Sitemap: {cfg['url']}/sitemap.xml
""")
today = datetime.date.today().isoformat()
(PUB / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    "".join(f"  <url><loc>{cfg['url']}{p}</loc><lastmod>{d}</lastmod></url>\n" for p, d in sitemap + [("/app/", today)]) + "</urlset>\n")
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
if ADS_ON:   # Google's ads come from many changing hosts: scripts and frames over https only, inline styles for the ad itself
    SITE_CSP = ("default-src 'self'; script-src 'self' https:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https:; "
                "connect-src 'self' https:; frame-src https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
rules = [f"/*\n  Content-Security-Policy: {SITE_CSP}\n{common}"]
rules.append(f"/app/*\n  ! Content-Security-Policy\n  Content-Security-Policy: {APP_CSP}\n")
# Word and LibreOffice documents: the word processor (EdenText) is shown in a frame of the editor; it runs
# WebAssembly, its own inline script (by hash) and inline styles, and connects to no other site (its AI
# assistant and dictation are off: edentext.config.json); only this site may frame it
EDT_CSP = (f"default-src 'self'; script-src 'self' 'wasm-unsafe-eval' {' '.join(EDT_HASHES)}; style-src 'self' 'unsafe-inline'; "
           "img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; "
           "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
rules.append(f"/app/edentext/*\n  ! Content-Security-Policy\n  ! X-Frame-Options\n  Content-Security-Policy: {EDT_CSP}\n  X-Frame-Options: SAMEORIGIN\n")
rules.append("/app/edentext/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n")
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

todo = [k for k in ("email",) if cfg["publisher"][k].startswith("[") or "example" in cfg["publisher"][k].lower()]
n = sum(1 for p in PUB.rglob("*") if p.is_file())
print(f"site built in {PUB} ({n} files, languages: {', '.join(LANGS)}) for {cfg['url']}")
if todo: print("NOTE: placeholder publisher " + ", ".join(todo) + " in site/site.json (licence and privacy contact)")
