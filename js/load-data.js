/*
 * Loads everything in /data (as listed in data/manifest.json), assembles it into
 * window.DATA in the shape js/app.js expects, then starts the app.
 *
 * File kinds in the manifest:
 *   json  - parsed as-is
 *   lines - text, one record per line; lines starting with "#" are comments.
 *           Records are re-joined with the manifest's "sep" (";" or newline).
 *   csv   - first line is a header (for humans); the rest are records joined with "sep".
 *   value - a literal value given in the manifest itself.
 * Race files may carry keys starting with "_" (notes for humans); those are dropped.
 */
(async function () {
  const base = "data/";
  const get = async (path, as) => {
    const res = await fetch(base + path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return as === "json" ? res.json() : res.text();
  };
  const setPath = (obj, key, val) => {
    const ks = key.split(".");
    let o = obj;
    ks.slice(0, -1).forEach(k => (o = o[k] = o[k] || {}));
    o[ks[ks.length - 1]] = val;
  };
  const textRecords = (txt, kind) => {
    let lines = txt.replace(/\r\n/g, "\n").split("\n").filter(l => l.trim() !== "");
    if (kind === "lines") lines = lines.filter(l => !l.startsWith("#"));
    if (kind === "csv") lines = lines.slice(1);
    return lines;
  };

  try {
    const manifest = await get("manifest.json", "json");
    const DATA = {};

    const raceFiles = await get(manifest.races, "json");
    const raceDir = manifest.races.replace(/[^/]*$/, "");
    DATA.races = await Promise.all(raceFiles.map(async f => {
      const r = await get(raceDir + f, "json");
      Object.keys(r).filter(k => k.startsWith("_")).forEach(k => delete r[k]);
      return r;
    }));
    DATA.candidates = await get("candidates.json", "json");

    await Promise.all(manifest.parts.map(async p => {
      let val;
      if ("value" in p) val = p.value;
      else if (p.kind === "json") val = await get(p.file, "json");
      else val = textRecords(await get(p.file), p.kind).join(p.sep);
      setPath(DATA, p.key, val);
    }));

    window.DATA = DATA;
    const s = document.createElement("script");
    s.src = "js/app.js";
    document.body.appendChild(s);
  } catch (err) {
    console.error(err);
    const msg = location.protocol === "file:"
      ? "This page loads its data with fetch(), which browsers block for files opened directly from disk. Run a local web server in the project folder (for example: python3 -m http.server) and open http://localhost:8000."
      : "Couldn't load the data files: " + err.message;
    const div = document.createElement("div");
    div.style.cssText = "position:fixed;inset:auto 16px 16px 16px;padding:14px 16px;background:#fff3f0;border:1px solid #d9534f;border-radius:8px;font:14px system-ui;z-index:9999;color:#222";
    div.textContent = msg;
    document.body.appendChild(div);
  }
})();
