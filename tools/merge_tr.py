"""Merge tools/tr/<lang>.json (new editor texts) into web/i18n/<lang>.json: texts with {placeholders} go to patterns."""
import json, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
keys = json.loads((ROOT / "tools/new-strings.json").read_text())
done = []
for f in sorted((ROOT / "tools/tr").glob("*.json")):
    l = f.stem; tr = json.loads(f.read_text())
    miss = [k for k in keys if k not in tr]
    if miss: print(l, "missing", len(miss)); continue
    d = json.loads((ROOT / f"web/i18n/{l}.json").read_text())
    for k in keys:
        v = tr[k]
        if re.search(r"\{\w+\}", k): d["patterns"] = [p for p in d["patterns"] if p[0] != k] + [[k, v]]
        else: d["strings"][k] = v
    (ROOT / f"web/i18n/{l}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n")
    done.append(l)
print("merged:", ", ".join(done))
