# New Orleans DSA Electoral Analyses

An interactive map of precinct-level election results, demographics and DSA membership for Orleans, Jefferson, St. Bernard and St. Tammany parishes. It is used to see how DSA-endorsed (★) and recommended candidates have performed, and to plan upcoming races and outreach.

It is a static site: plain HTML, CSS and JavaScript, plus data files. There is no build step and nothing to install to view it.

## Views

| View | What it shows |
|---|---|
| **Election Data → Previous elections** | Each endorsed or recommended candidate's vote share by precinct |
| **Election Data → Upcoming elections** | How DSA candidates have done inside each district on the 2027–2029 ballots |
| **Election Data → Trends & data** | Precinct rankings across all candidates, filterable by district; CSV export |
| **Demographics** | Census measures (renters, cost burden, income, poverty, wage workers, race), a working-class index, and voter registration by party |
| **Membership** | DSA members by ZIP code and by upcoming-race district, with incumbents, open seats, DSA-held seats and targets |
| **Summary** | *Where to run* (scores districts, with **Export Dossier**: a Discourse-ready markdown dossier for the selected district) and *Where to intervene* (flags precincts for events, recruitment or social inquiry) |

## Viewing it

**On GitHub Pages:** push the repo to GitHub, then go to **Settings → Pages**. Set **Source** to *Deploy from a branch*, pick your branch (e.g. `main`) and the `/ (root)` folder, then save. The site will be at `https://<your-user>.github.io/<repo-name>/` within a minute or two.

**On your computer:** the page loads its data with `fetch()`, which browsers block for files opened straight from disk. Start a small web server in the project folder instead:

```sh
python3 -m http.server
# then open http://localhost:8000
```

If you want a single file you can double-click, email or host elsewhere, run `python3 scripts/build_standalone.py`. It writes `dist/standalone.html`, which has everything inlined.

## Project layout

```
index.html                  page markup (loads css/, d3, then js/load-data.js)
css/styles.css              all styles; colors are CSS variables at the top (light + dark)
js/load-data.js             reads data/manifest.json, assembles window.DATA, starts the app
js/app.js                   the application (maps, tables, scoring)
data/
  manifest.json             which file feeds which part of the data, and how to read it
  candidates.json           endorsed / recommended candidates (one per line)
  registration.csv          registered voters by party, per precinct (SOS, Oct. 1, 2026)
  races/
    index.json              ordered list of race files
    <date>_<raceid>_<title>.json   one file per race: choices + per-precinct results
  upcoming/
    districts.json          upcoming races: incumbents, open seats, DSA seats, targets, member counts
    district-shapes.txt     district outlines (generated)
  members/
    counts-by-zip.json      members per ZIP: [in good standing, in good standing + lapsed]
    zip-shapes.txt          ZIP outlines + 2020 population (generated)
  demographics/
    acs-tracts.csv          ACS 2020–2024 5-year estimates per census tract (and parish totals)
    orleans-tract-shapes.txt, metro-tract-shapes.txt   tract outlines (generated)
    tract-district-split.txt                           tract → council / school board / congress shares
  geography/
    orleans-precincts.txt, metro-precincts.txt         precinct outlines (generated)
    precinct-districts.json                            precinct → House (h), Council (c), Congress (g), School Board (s)
    orleans-precinct-tract-zip.txt, metro-precinct-tract-zip.txt   precinct → tract and ZIP area shares
    school-board-inferred-precincts.json               Orleans precincts whose school board district is inferred
scripts/
  add_race.py               download a race from the Secretary of State and add it
  build_standalone.py       build dist/standalone.html; --check validates the data
```

**Precinct IDs.** Orleans precincts are `ward-precinct` (`9-28`, `4-17A`). Suburban precincts carry a parish prefix: `J:` Jefferson, `B:` St. Bernard, `T:` St. Tammany (`J:125A`, `T:S22`).

The `.txt` shape files hold delta-encoded outlines (`id|x,y dx,dy dx,dy …`, in 1e-5 degree units; `^` separates polygons and `~` separates rings). They are generated from Census and Louisiana Legislature shapefiles and are not meant to be edited by hand. Lines starting with `#` are comments.

## Common updates

### Add election results

Find the race on the [Secretary of State's results site](https://voterportal.sos.la.gov/) and open the results by parish. The address has the date, race ID and parish code:

```
https://voterportal.sos.la.gov/static/2026-11-03/resultsRegion/70195/26
                                     date        race id ^     ^ parish
```

Parish codes: `36` Orleans, `26` Jefferson, `44` St. Bernard, `52` St. Tammany.

```sh
# 1. see the choices and their IDs
python3 scripts/add_race.py --date 2026-11-03 --race 70195 --parishes 36 --list

# 2. add it (--star for DSA-endorsed; leave it off for recommended)
python3 scripts/add_race.py --date 2026-11-03 --race 70195 --parishes 36,26,44,52 \
    --title "U.S. House, LA-01" --candidate 124814 --label "Lauren Jewett" --star

# 3. check the data
python3 scripts/build_standalone.py --check
```

Running it again for a race that's already there replaces the results. Use this once results are certified. If the SOS site refuses the script's download, open each parish's data link in your browser and save the files into a folder, then pass `--from-dir that-folder`. Run `--help` to see the file names.

**Doing it by hand:** copy an existing file in `data/races/`, add its filename to `data/races/index.json`, and add the candidate to `data/candidates.json`.
- Each precinct row is `[registered, voted, votes for choice 1, votes for choice 2, …]` in the order of `choices`. `_columns` spells this out.
- `unalloc` holds early and provisional votes, which the state reports parish-wide rather than by precinct.
- `multi` is `1` for races that cross parish lines.
- A race's type (D v D, D v R, Mixed, Measure) comes from the candidates' parties: `DEM`, `REP`, `NOPTY`, or `""` for ballot-measure Yes/No.

### Candidates

`data/candidates.json` lists one entry per endorsed or recommended candidate: `race` and `choice` IDs, the `label` shown in the app, and `star` (`1` endorsed, `0` recommended). **Add new candidates at the end.** The app remembers the selected candidate by position, so reordering only resets that selection.

### Upcoming races, incumbents and targets

Edit `data/upcoming/districts.json`. There is one line per district, grouped by `house`, `dscc`, `cong`, `council` and `sb` (school board).

| Field | Meaning |
|---|---|
| `party` | Incumbent's party: `"D"`, `"R"` or `""` |
| `tl` | `true` if the seat is open because the incumbent is term-limited |
| `open` | *(optional)* any other reason the seat is open, e.g. `"incumbent elected to another office"` |
| `dsa` | `"Y"` DSA-held, `"Former"` formerly DSA-held, `""` otherwise |
| `target` | `true` if DSA is targeting the seat |
| `year` | Election year |
| `migs`, `all`, `int` | Members in good standing, good standing + lapsed, and interested, in the district |

DSCC districts have two seats, so their `party`, `tl`, `dsa` and `target` live under `offices.A` and `offices.B`.

### Members

`data/members/counts-by-zip.json`: `"ZIP": [in good standing, in good standing + lapsed]`. Update the date in `data/manifest.json` (`members.asOf`) when you refresh it.

### Styles and code

Colors, fonts and spacing are CSS variables at the top of `css/styles.css`, with dark-mode values just below. The app logic is in `js/app.js`; it reads everything from `DATA`, which `js/load-data.js` builds from the files above. Settings such as the "high" and "low" percentile cutoffs for Where to intervene (`WC_HIGH`) and the DSCC race weights (`RACE_W`) are constants you can search for in `js/app.js`.

## Sources

- **Election results:** Louisiana Secretary of State, [Voter Portal](https://voterportal.sos.la.gov/), official precinct returns. Results from 2022–2024 are drawn on today's precinct boundaries.
- **Voter registration:** Louisiana Secretary of State, parish report of registered voters, Oct. 1, 2026.
- **Demographics:** U.S. Census Bureau, American Community Survey 2020–2024 5-year estimates, via [Census Reporter](https://censusreporter.org/).
- **Boundaries:**
  - Census TIGERweb / TIGER 2024: tracts, ZIP Code Tabulation Areas, State House (2026 lines), 120th Congress.
  - Louisiana Legislature 2024 precinct shapefile: suburban precincts.
  - City Council and School Board districts are built from Orleans precincts.
- **Members, incumbents and targets:** New Orleans DSA's upcoming-races sheet.

## A note on privacy

`data/members/` and `data/upcoming/districts.json` contain member counts by ZIP and district, plus DSA's targets. On GitHub Pages, a **public** repository makes these visible to anyone. If they shouldn't be public, keep the repository private. Pages for private repos requires a paid GitHub plan; otherwise use the standalone file and share it privately.
