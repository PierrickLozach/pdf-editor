"""Check the translations: python3 tools/check_i18n.py [lang ...]   (default: every language)

For each language of web/i18n/languages.json (except English, the source):
  - web/i18n/<lang>.json   the editor: every English text of the French dictionary (the reference
                           list) is translated, {placeholders} are kept, nothing is empty
  - site/i18n/<lang>.json  the words of the site's header and footer: every key of en.json
  - site/pages/<lang>/     every page of site/pages/en/, with the same {{variables}}, the same links
                           (href), the same HTML elements and a title and a description
Exits with an error listing every problem. Warnings (texts left identical to English) do not fail."""
import html.parser, json, pathlib, re, sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
LANGS = [x["code"] for x in json.loads((ROOT / "web/i18n/languages.json").read_text())]
want = sys.argv[1:] or [l for l in LANGS if l != "en"]
REF = json.loads((ROOT / "web/i18n/fr.json").read_text())
SITE_REF = json.loads((ROOT / "site/i18n/en.json").read_text())
PH = re.compile(r"\{(\w+)\}")
KEEP = {"OK", "PDF", "MuPDF", "Image", "Pages", "Google Fonts", "AGPL"}     # may stay identical

class Shape(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags, self.hrefs, self.stack, self.errors = Counter(), Counter(), [], []
    VOID = {"br", "img", "input", "meta", "link", "hr", "path", "circle", "rect", "source"}
    def handle_starttag(self, tag, attrs):
        self.tags[tag] += 1
        for k, v in attrs:
            if k == "href": self.hrefs[v] += 1
        if tag not in self.VOID: self.stack.append(tag)
    def handle_startendtag(self, tag, attrs): self.handle_starttag(tag, attrs); self.stack.pop() if tag not in self.VOID and self.stack else None
    def handle_endtag(self, tag):
        if tag in self.VOID: return
        if not self.stack or self.stack[-1] != tag: self.errors.append(f"unexpected </{tag}>"); return
        self.stack.pop()

def shape(text):
    s = Shape(); s.feed(text); s.close()
    if s.stack: s.errors.append("not closed: " + ", ".join(s.stack[-3:]))
    return s

def page_meta(raw):
    m = re.match(r"\s*<!--(.*?)-->\s*", raw, re.S)
    return (dict(re.findall(r"^\s*([a-z]+):\s*(.*?)\s*$", m.group(1), re.M)), raw[m.end():]) if m else ({}, raw)

problems, warnings = [], []
for lang in want:
    P = lambda m: problems.append(f"[{lang}] {m}")
    W = lambda m: warnings.append(f"[{lang}] {m}")
    # ------------------------------------------------------------ editor
    f = ROOT / "web/i18n" / f"{lang}.json"
    if not f.exists(): P(f"missing {f.relative_to(ROOT)}")
    else:
        try: d = json.loads(f.read_text())
        except Exception as e: P(f"{f.name}: not valid JSON ({e})"); d = {"strings": {}, "patterns": []}
        st = d.get("strings", {})
        for k in REF["strings"]:
            v = st.get(k)
            if v is None: P(f"editor: missing translation of {k!r}"); continue
            if not str(v).strip() and k.strip(): P(f"editor: empty translation of {k!r}")
            if sorted(PH.findall(k)) != sorted(PH.findall(v)): P(f"editor: placeholders differ in {k!r} -> {v!r}")
            if v == k and len(k) > 12 and k not in KEEP: W(f"editor: left in English: {k[:60]!r}")
        pats = {p[0]: p[1] for p in d.get("patterns", []) if isinstance(p, list) and len(p) == 2}
        for src, _ in REF["patterns"]:
            v = pats.get(src)
            if v is None: P(f"editor: missing pattern {src!r}"); continue
            if Counter(PH.findall(src)) != Counter(PH.findall(v)): P(f"editor: placeholders differ in pattern {src!r} -> {v!r}")
    # ------------------------------------------------------------ site words
    f = ROOT / "site/i18n" / f"{lang}.json"
    if not f.exists(): P(f"missing {f.relative_to(ROOT)}")
    else:
        try: d = json.loads(f.read_text())
        except Exception as e: P(f"{f.name}: not valid JSON ({e})"); d = {}
        for k in SITE_REF:
            if k == "months": continue
            if k not in d: P(f"site words: missing {k!r}")
        if "%B" in d.get("date_format", "") and len(d.get("months", [])) != 12: P("site words: date_format uses %B: 12 month names needed in \"months\"")
        dirs = {x["code"]: x["dir"] for x in json.loads((ROOT / "web/i18n/languages.json").read_text())}
        if d.get("dir") != dirs.get(lang): P(f"site words: \"dir\" must be {dirs.get(lang)!r}")
    # ------------------------------------------------------------ site pages
    for src in sorted(p for p in (ROOT / "site/pages/en").glob("*.html") if p.stem != "developers"):   # developers: English only
        f = ROOT / "site/pages" / lang / src.name
        if not f.exists(): P(f"missing page {f.relative_to(ROOT)}"); continue
        em, eb = page_meta(src.read_text()); lm, lb = page_meta(f.read_text())
        for k in ("title", "description"):
            if not lm.get(k): P(f"{src.name}: no {k} in the header comment")
        if em.get("noindex") and not lm.get("noindex"): P(f"{src.name}: \"noindex: true\" missing")
        if Counter(re.findall(r"\{\{[a-z.]+\}\}", eb + em.get("title", "") + em.get("description", ""))) - Counter(re.findall(r"\{\{[a-z.]+\}\}", lb + lm.get("title", "") + lm.get("description", ""))):
            P(f"{src.name}: some {{{{variables}}}} are missing or changed")
        es, ls = shape(eb), shape(lb)
        for e in ls.errors: P(f"{src.name}: HTML {e}")
        if es.hrefs != ls.hrefs: P(f"{src.name}: links differ: {sorted((es.hrefs - ls.hrefs) + (ls.hrefs - es.hrefs))[:4]}")
        diff = {t: (es.tags[t], ls.tags[t]) for t in set(es.tags) | set(ls.tags) if es.tags[t] != ls.tags[t] and t not in ("b", "i", "em", "strong", "br")}
        # legal pages end with one extra paragraph: "this translation is for convenience; the French version prevails"
        if lang != "fr" and src.name in ("privacy.html", "cookies.html", "terms.html", "legal.html"):
            if ls.tags["p"] == es.tags["p"] + 1: diff.pop("p", None)
            elif ls.tags["p"] == es.tags["p"]: P(f"{src.name}: the closing paragraph about the French version prevailing is missing")
        if diff: P(f"{src.name}: HTML elements differ (en, {lang}): {diff}")

for w in warnings[:40]: print("warning:", w)
if len(warnings) > 40: print(f"warning: … {len(warnings) - 40} more")
if problems:
    print(f"\n{len(problems)} PROBLEM(S)"); [print(" ", p) for p in problems[:80]]
    if len(problems) > 80: print(f"  … {len(problems) - 80} more")
    sys.exit(1)
print(f"translations OK: {', '.join(want)}")
