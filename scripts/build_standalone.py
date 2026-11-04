#!/usr/bin/env python3
"""
Build a single self-contained HTML file (page + styles + code + all data inlined).

The repo itself is what GitHub Pages serves; this is for when you want one file
you can open straight from disk, email, or paste into another host.

    python3 scripts/build_standalone.py            # writes dist/standalone.html
    python3 scripts/build_standalone.py --check    # also validates every data file

It assembles the data exactly the way js/load-data.js does in the browser.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def text_records(txt, kind):
    lines = [l for l in txt.replace("\r\n", "\n").split("\n") if l.strip()]
    if kind == "lines":
        lines = [l for l in lines if not l.startswith("#")]
    if kind == "csv":
        lines = lines[1:]
    return lines


def set_path(obj, key, val):
    ks = key.split(".")
    for k in ks[:-1]:
        obj = obj.setdefault(k, {})
    obj[ks[-1]] = val


def load_data():
    manifest = json.loads((DATA_DIR / "manifest.json").read_text())
    data = {}
    race_index = DATA_DIR / manifest["races"]
    races = []
    for f in json.loads(race_index.read_text()):
        r = json.loads((race_index.parent / f).read_text())
        races.append({k: v for k, v in r.items() if not k.startswith("_")})
    data["races"] = races
    data["candidates"] = json.loads((DATA_DIR / "candidates.json").read_text())
    for p in manifest["parts"]:
        if "value" in p:
            val = p["value"]
        elif p["kind"] == "json":
            val = json.loads((DATA_DIR / p["file"]).read_text())
        else:
            val = p["sep"].join(text_records((DATA_DIR / p["file"]).read_text(), p["kind"]))
        set_path(data, p["key"], val)
    return data


def check(data):
    """Basic consistency checks that catch most hand-editing mistakes."""
    problems = []
    races = {r["id"]: r for r in data["races"]}
    if len(races) != len(data["races"]):
        problems.append("duplicate race ids in data/races/index.json")
    for r in data["races"]:
        n = len(r["choices"])
        for pid, row in r["precincts"].items():
            if len(row) != n + 2:
                problems.append(f"race {r['id']} precinct {pid}: expected {n + 2} numbers, got {len(row)}")
        for label, vals in r["unalloc"]:
            if len(vals) != n:
                problems.append(f"race {r['id']} '{label}': expected {n} numbers, got {len(vals)}")
    for i, c in enumerate(data["candidates"]):
        r = races.get(c["race"])
        if not r:
            problems.append(f"candidate #{i} {c['label']}: race {c['race']} not found")
        elif not any(ch["id"] == c["choice"] for ch in r["choices"]):
            problems.append(f"candidate #{i} {c['label']}: choice {c['choice']} not in race {c['race']}")
    return problems


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "dist" / "standalone.html"))
    ap.add_argument("--check", action="store_true", help="validate data and exit non-zero on problems")
    args = ap.parse_args()

    data = load_data()
    problems = check(data)
    for p in problems:
        print("PROBLEM:", p, file=sys.stderr)
    if args.check and problems:
        sys.exit(1)

    html = (ROOT / "index.html").read_text()
    css = (ROOT / "css" / "styles.css").read_text()
    app = (ROOT / "js" / "app.js").read_text()
    # "</" inside inline <script> would end the tag early; escape it in the JSON
    data_js = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    app = app.replace("const DATA = window.DATA;", "const DATA = " + data_js + ";", 1)
    html = html.replace('<link rel="stylesheet" href="css/styles.css">', "<style>\n" + css + "</style>")
    html = re.sub(r'<script src="js/load-data\.js"></script>', lambda m: "<script>\n" + app + "</script>", html)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB), {len(data['races'])} races, {len(data['candidates'])} candidates")


if __name__ == "__main__":
    main()
