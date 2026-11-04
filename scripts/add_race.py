#!/usr/bin/env python3
"""
Add (or refresh) a race from the Louisiana Secretary of State's results site.

Find the race on https://voterportal.sos.la.gov/ and open its results by parish.
The address looks like this:

    https://voterportal.sos.la.gov/static/2026-11-03/resultsRegion/70195/26
                                          ^ date        race id ^    ^ parish code

Parish codes: 36 Orleans, 26 Jefferson, 44 St. Bernard, 52 St. Tammany.

Examples
--------
  # DSA-endorsed candidate (starred) in a race that crosses all four parishes
  python3 scripts/add_race.py --date 2026-11-03 --race 70195 --parishes 36,26,44,52 \\
      --title "U.S. House, LA-01" --candidate 124814 --label "Lauren Jewett" --star

  # Recommended candidate (no star); title is taken from the SOS if omitted
  python3 scripts/add_race.py --date 2026-11-03 --race 69641 --parishes 52 --candidate 127574

  # Just list the race's choices (to find a candidate's choice id), change nothing
  python3 scripts/add_race.py --date 2026-11-03 --race 70195 --parishes 26 --list

Re-running for a race that's already there replaces its results (useful once
results are certified) and keeps its candidate entries.

What it writes
--------------
  data/races/<date>_<race id>_<title>.json   precinct results
  data/races/index.json                      the race is appended to the list
  data/candidates.json                       the candidate is appended (if --candidate)

Afterwards run  python3 scripts/build_standalone.py --check  to validate.
If the SOS site blocks the script, save each parish's file from your browser
instead (see --from-dir).
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RACES = ROOT / "data" / "races"
BASE = "https://voterportal.sos.la.gov/ElectionResults/ElectionResults/Data?blob="
PARISH_PREFIX = {"36": None, "26": "J", "44": "B", "52": "T"}  # None = Orleans "ward-precinct" ids
PARISH_NAME = {"36": "Orleans", "26": "Jefferson", "44": "St. Bernard", "52": "St. Tammany"}


def fetch(blob, from_dir=None):
    """Fetch one SOS data file (they're JSON despite the .htm name)."""
    if from_dir:
        p = Path(from_dir) / blob.split("/")[-1]
        if not p.exists():
            sys.exit(f"missing {p} (save {BASE + blob} to that name)")
        return json.loads(p.read_text())
    req = urllib.request.Request(BASE + blob, headers={"User-Agent": "Mozilla/5.0 (precinct-results script)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def precinct_id(name, parish):
    """'04/17A' in Orleans -> '4-17A'; '00/125A' in Jefferson -> 'J:125A'."""
    ward, pct = name.split("/")
    if PARISH_PREFIX[parish] is None:
        return f"{int(ward)}-{re.sub(r'^0+(?=[0-9])', '', pct)}"
    return f"{PARISH_PREFIX[parish]}:{pct}"


def find_race_meta(date_key, race, parishes, from_dir):
    """Title and choices from the SOS race list (multi-parish list first, then each parish's own)."""
    blobs = [f"{date_key}/RacesCandidates_Multiparish.htm"] + [f"{date_key}/RacesCandidates/ByParish_{p}.htm" for p in parishes]
    for blob in blobs:
        try:
            txt = json.dumps(fetch(blob, from_dir))
        except SystemExit:
            continue
        except Exception as e:  # a parish list may not exist; keep looking
            print(f"  (couldn't read {blob}: {e})", file=sys.stderr)
            continue
        # walk the JSON for a dict with this race ID
        def walk(o):
            if isinstance(o, dict):
                if o.get("ID") == race and "Choice" in o:
                    return o
                for v in o.values():
                    f = walk(v)
                    if f:
                        return f
            elif isinstance(o, list):
                for v in o:
                    f = walk(v)
                    if f:
                        return f
        found = walk(json.loads(txt))
        if found:
            return found
    sys.exit(f"race {race} not found in the SOS race lists for {date_key}")


def split_desc(desc):
    """'Lauren Jewett (DEM)' -> ('Lauren Jewett', 'DEM'); 'YES' -> ('Yes', '')."""
    m = re.match(r"^(.*?)\s*\(([A-Z]+)\)\s*$", desc)
    if m:
        return m.group(1).strip(), m.group(2)
    return desc.strip().capitalize() if desc.strip().upper() in ("YES", "NO") else desc.strip(), ""


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def fmt(v):
    return json.dumps(v, ensure_ascii=False, separators=(", ", ": "))


def write_race(r, path):
    cols = ["registered", "voted"] + [c["name"] for c in r["choices"]]
    lines = ["{",
             f'  "id": {fmt(r["id"])},',
             f'  "date": {fmt(r["date"])},',
             f'  "title": {fmt(r["title"])},',
             f'  "multi": {fmt(r["multi"])},',
             '  "choices": [\n' + ",\n".join("    " + fmt(c) for c in r["choices"]) + "\n  ],",
             f'  "_columns": {fmt(cols)},',
             f'  "_source": {fmt(r["_source"])},',
             '  "unalloc": [\n' + ",\n".join("    " + fmt(u) for u in r["unalloc"]) + "\n  ],",
             '  "precincts": {\n' + ",\n".join(f"    {json.dumps(p)}: {fmt(v)}" for p, v in r["precincts"].items()) + "\n  }",
             "}"]
    path.write_text("\n".join(lines) + "\n")


def write_list(items, path):
    path.write_text("[\n" + ",\n".join("  " + fmt(x) for x in items) + "\n]\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", required=True, help="election date, YYYY-MM-DD")
    ap.add_argument("--race", required=True, help="SOS race id (from the results URL)")
    ap.add_argument("--parishes", required=True, help="comma-separated parish codes: 36 Orleans, 26 Jefferson, 44 St. Bernard, 52 St. Tammany")
    ap.add_argument("--title", help="title shown in the app (default: the SOS title)")
    ap.add_argument("--candidate", help="choice id of the DSA endorsed/recommended candidate (see --list)")
    ap.add_argument("--label", help="how the candidate is listed in the app (default: their ballot name)")
    ap.add_argument("--star", action="store_true", help="DSA-endorsed (starred); omit for recommended")
    ap.add_argument("--list", action="store_true", help="print the race's choices and exit")
    ap.add_argument("--from-dir", help="read saved SOS files from this folder instead of downloading")
    a = ap.parse_args()

    date_key = a.date.replace("-", "")
    parishes = [p.strip() for p in a.parishes.split(",") if p.strip()]
    bad = [p for p in parishes if p not in PARISH_PREFIX]
    if bad:
        sys.exit(f"unknown parish code(s) {bad}; this project covers {PARISH_NAME}")

    meta = find_race_meta(date_key, a.race, parishes, a.from_dir)
    choices = []
    for c in meta["Choice"]:
        name, party = split_desc(c["Desc"])
        choices.append({"id": c["ID"], "name": name, "party": party})
    if a.list:
        print(meta.get("SpecificTitle", ""))
        for c in choices:
            print(f"  {c['id']}  {c['name']}  {c['party']}")
        return

    order = [c["id"] for c in choices]
    precincts, unalloc = {}, {}
    for p in parishes:
        data = fetch(f"{date_key}/VotesRaceByPrecinct/Votes_{a.race}_{p}.htm", a.from_dir)
        rows = data["Precincts"]["Precinct"]
        n_rep = 0
        for row in rows:
            votes = {ch["ID"]: int(ch["VoteTotal"] or 0) for ch in row["Choice"]}
            v = [votes.get(cid, 0) for cid in order]
            name = row["Precinct"]
            if name in ("Early Voting", "Provisional Votes"):
                label = "Early voting" if name == "Early Voting" else "Provisional"
                unalloc[label] = [x + y for x, y in zip(unalloc.get(label, [0] * len(order)), v)]
                continue
            reg = int(row.get("VoterCountQualified") or 0)
            if not reg and not sum(v):
                continue  # listed but not actually voting in this race
            n_rep += row.get("HasReported") == "1"
            precincts[precinct_id(name, p)] = [reg, int(row.get("VoterCountVoted") or 0)] + v
        print(f"  {PARISH_NAME[p]}: {len(rows)} rows, {n_rep} precincts reported")

    title = a.title or meta.get("SpecificTitle", f"Race {a.race}")
    race = {
        "id": a.race,
        "date": a.date,
        "title": title,
        "multi": 1 if meta.get("IsMultiParish") == "1" else 0,
        "choices": choices,
        "_source": [f"https://voterportal.sos.la.gov/static/{a.date}/resultsRegion/{a.race}/{p}" for p in parishes],
        "unalloc": [[k, v] for k, v in unalloc.items()],
        "precincts": precincts,
    }

    index_path = RACES / "index.json"
    index = json.loads(index_path.read_text())
    old = [f for f in index if f.split("_")[1] == a.race]
    fname = f"{a.date}_{a.race}_{slug(title)}.json"
    pos = index.index(old[0]) if old else len(index)
    for f in old:  # refreshing an existing race: replace its file, keep its place in the list
        index.remove(f)
        (RACES / f).unlink(missing_ok=True)
    write_race(race, RACES / fname)
    index.insert(pos, fname)
    write_list(index, index_path)
    print(f"{'updated' if old else 'added'} {fname}: {len(precincts)} precincts")

    if a.candidate:
        cand_path = ROOT / "data" / "candidates.json"
        cands = json.loads(cand_path.read_text())
        ch = next((c for c in choices if c["id"] == a.candidate), None)
        if not ch:
            sys.exit(f"choice {a.candidate} isn't in this race; run with --list to see the choices")
        if any(c["race"] == a.race and c["choice"] == a.candidate for c in cands):
            print("candidate already listed; left as is")
        else:
            cands.append({"race": a.race, "choice": a.candidate, "label": a.label or ch["name"], "star": 1 if a.star else 0})
            write_list(cands, cand_path)
            print(f"added candidate {a.label or ch['name']}{' (starred)' if a.star else ''}")


if __name__ == "__main__":
    main()
