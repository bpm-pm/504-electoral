// DATA is assembled from the files in /data by js/load-data.js before this script runs.
const DATA = window.DATA;
const CANDIDATES = DATA.candidates;           // {race, choice, label, star}
const races = Object.fromEntries(DATA.races.map(r => [r.id, r]));
const STAR = cls => `<svg class="star ${cls || ""}" aria-label="DSA & recommended" role="img"><use href="#star"/></svg>`;
// race type from the party labels on the ballot
function raceType(race) {
  if (race._rt) return race._rt;
  const ps = race.choices.map(c => c.party || "");
  const n = p => ps.filter(x => x === p).length;
  let rt;
  if (ps.every(p => !p)) rt = { code: "m", label: "Measure", long: "ballot measure", tip: "Ballot measure (Yes / No)" };
  else if (ps.every(p => p === "DEM")) rt = { code: "dd", label: "D v D", long: "all-Democrat race", tip: "All-Democrat race: every candidate was a Democrat" };
  else if (n("DEM") === 1 && n("REP") >= 1) rt = { code: "dr", label: "D v R", long: "Democrat vs. Republican", tip: "Democrat vs. Republican: one Democrat against Republican opposition" };
  else rt = { code: "mx", label: "Mixed", long: "mixed field", tip: "Mixed field: " + [...new Set(ps)].sort().join(", ") };
  return (race._rt = rt);
}
const RT = race => { const r = raceType(race); return `<span class="rtype rt-${r.code}" title="${r.tip}">${r.label}</span>`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dateFmt = d3.utcFormat("%b %-d, %Y");
const dateLabel = iso => dateFmt(new Date(iso + "T12:00:00Z"));

/* ---------- shapes: delta-encoded rings, 1e-5 degree units ---------- */
const features = DATA.shapes.split("\n").map(line => {
  const [id, body] = line.split("|");
  const polys = body.split("^").map(p => p.split("~").map(r => {
    let x = 0, y = 0;
    return r.split(" ").map(pt => { const [dx, dy] = pt.split(",").map(Number); x += dx; y += dy; return [x / 1e5, y / 1e5]; });
  }));
  const f = { type: "Feature", id, properties: { id, ward: +id.split("-")[0] }, geometry: { type: "MultiPolygon", coordinates: polys } };
  f.geometry.coordinates.forEach(poly => poly.forEach(ring => {
    if (d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI) ring.reverse();
  }));
  return f;
});
// Jefferson (J:), St. Bernard (B:) and St. Tammany (T:) precincts, 2024 lines from the Louisiana Legislature
const PARISH_NAME = { J: "Jefferson", B: "St. Bernard", T: "St. Tammany" };
const metroFeatures = (DATA.metro || "").split("\n").filter(Boolean).map(line => {
  const [id, body] = line.split("|");
  const polys = body.split("^").map(p => p.split("~").map(r => {
    let x = 0, y = 0;
    return r.split(" ").map(pt => { const [dx, dy] = pt.split(",").map(Number); x += dx; y += dy; return [x / 1e5, y / 1e5]; });
  }));
  const f = { type: "Feature", id, properties: { id, parish: PARISH_NAME[id[0]] }, geometry: { type: "MultiPolygon", coordinates: polys } };
  f.geometry.coordinates.forEach(poly => poly.forEach(ring => { if (d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI) ring.reverse(); }));
  return f;
});
features.forEach(f => f.properties.parish = "Orleans");
const allFeatures = features.concat(metroFeatures);
const featById = new Map(allFeatures.map(f => [f.id, f]));
const isMetro = pid => pid.includes(":");
const parishOf = pid => isMetro(pid) ? PARISH_NAME[pid[0]] : "Orleans";
const pName = pid => isMetro(pid) ? `${PARISH_NAME[pid[0]]} ${pid.slice(2)}` : pid;          // display name
const pLabel = pid => isMetro(pid) ? `${PARISH_NAME[pid[0]]} precinct ${pid.slice(2)}` : `Precinct ${pid}`;
const pWard = pid => isMetro(pid) ? `${PARISH_NAME[pid[0]]} Parish` : `Ward ${pid.split("-")[0]}`;
const raceParishes = race => { const s = new Set(Object.keys(race.precincts).map(parishOf)); return ["Orleans", "Jefferson", "St. Bernard", "St. Tammany"].filter(p => s.has(p)); };
const listAnd = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + (a.length > 2 ? "," : "") + " and " + a[a.length - 1];

/* ---------- state ---------- */
let state = { cand: 0, metric: "pct", selected: null, compare: null, tab: "prev", up: { e: "house", d: null, group: "dsa" } };
try {
  const s = JSON.parse(localStorage.getItem("nola-precinct-state-v2") || "{}");
  if (s.metric) state.metric = s.metric;
  if (Number.isInteger(s.cand) && s.cand < CANDIDATES.length) state.cand = s.cand;
} catch (e) {}
const save = () => { try { localStorage.setItem("nola-precinct-state-v2", JSON.stringify({ cand: state.cand, metric: state.metric })); } catch (e) {} };

const fmt = d3.format(",");
const pctFmt = v => (v * 100).toFixed(1) + "%";
const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || "th");

function candInfo(i) {
  const c = CANDIDATES[i], race = races[c.race];
  const idx = race.choices.findIndex(ch => ch.id === c.choice);
  return { c, race, idx, choice: race.choices[idx] };
}
function precinctStats(race, idx, pid) {
  const row = race.precincts[pid];
  if (!row) return null;
  const votes = row.slice(2), total = d3.sum(votes), v = votes[idx];
  const max = d3.max(votes);
  return { reg: row[0], voted: row[1], votes, total, v, pct: total ? v / total : 0, won: v === max && v > 0, rank: 1 + votes.filter(x => x > v).length };
}
function raceTotals(race) {
  return race.choices.map((c, i) => d3.sum(Object.values(race.precincts), r => r[2 + i]) + d3.sum(race.unalloc, u => u[1][i]));
}

/* ---------- candidate picker ---------- */
const pickBtn = document.getElementById("pickBtn"), pickList = document.getElementById("pickList");
const order = CANDIDATES.map((c, i) => i).sort((a, b) => {
  const ra = races[CANDIDATES[a].race], rb = races[CANDIDATES[b].race];
  return d3.descending(ra.date, rb.date) || d3.descending(CANDIDATES[a].star, CANDIDATES[b].star) || a - b;
});
let activeIdx = -1;
function buildList() {
  pickList.innerHTML = "";
  let lastDate = null;
  order.forEach(i => {
    const { c, race } = candInfo(i);
    if (race.date !== lastDate) {
      lastDate = race.date;
      const g = document.createElement("li"); g.className = "grp"; g.setAttribute("role", "presentation");
      g.textContent = dateLabel(race.date); pickList.appendChild(g);
    }
    const li = document.createElement("li");
    li.className = "opt"; li.id = "opt-" + i; li.setAttribute("role", "option"); li.dataset.i = i;
    li.setAttribute("aria-selected", i === state.cand);
    li.innerHTML = `<span>${c.star ? STAR() : ""}</span><span class="n">${esc(c.label)} ${RT(race)}</span><span class="r">${esc(race.title)}</span>`;
    li.addEventListener("click", () => choose(i));
    pickList.appendChild(li);
  });
}
function setButton() {
  const { c, race } = candInfo(state.cand);
  pickBtn.innerHTML = `${c.star ? STAR("big") : ""}<span class="lbl">${esc(c.label)}</span>${RT(race)}<span class="yr">${race.date.slice(0, 4)}</span>
    <svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4"/></svg>`;
}
function openList() {
  buildList(); pickList.hidden = false; pickBtn.setAttribute("aria-expanded", "true");
  activeIdx = order.indexOf(state.cand); markActive(); pickList.focus();
}
function closeList(focusBtn) { pickList.hidden = true; pickBtn.setAttribute("aria-expanded", "false"); if (focusBtn) pickBtn.focus(); }
function markActive() {
  pickList.querySelectorAll(".opt").forEach(o => o.classList.remove("active"));
  const el = document.getElementById("opt-" + order[activeIdx]);
  if (el) { el.classList.add("active"); pickList.setAttribute("aria-activedescendant", el.id); el.scrollIntoView({ block: "nearest" }); }
}
function choose(i) { state.cand = i; state.compare = null; save(); closeList(true); render(true); }
pickBtn.addEventListener("click", () => pickList.hidden ? openList() : closeList(false));
pickBtn.addEventListener("keydown", e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openList(); } });
pickList.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(order.length - 1, activeIdx + 1); markActive(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); markActive(); }
  else if (e.key === "Home") { e.preventDefault(); activeIdx = 0; markActive(); }
  else if (e.key === "End") { e.preventDefault(); activeIdx = order.length - 1; markActive(); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(order[activeIdx]); }
  else if (e.key === "Escape" || e.key === "Tab") { closeList(e.key === "Escape"); }
});
document.addEventListener("pointerdown", e => { if (!pickList.hidden && !e.target.closest(".picker")) closeList(false); });

const mBtns = { pct: document.getElementById("m-pct"), votes: document.getElementById("m-votes") };
Object.entries(mBtns).forEach(([k, b]) => b.addEventListener("click", () => { state.metric = k; save(); render(false); }));

/* ---------- map ---------- */
const svg = d3.select("#map");
const root = svg.append("g");
const gHalo = root.append("g"), gPrec = root.append("g"), gLab = root.append("g"), gSel = root.append("g");
const projection = d3.geoMercator();
const path = d3.geoPath(projection);
const fc = { type: "FeatureCollection", features };

// measure the map's container, not the <svg>: some browsers report 0 for an svg's clientWidth
function boxSize(el) { const r = el.getBoundingClientRect(); return [Math.round(r.width) || 800, Math.round(r.height) || 600]; }
function size() { return boxSize(svg.node().parentNode); }
function layout() {
  const [w, h] = size();
  projection.fitExtent([[20, 80], [w - 20, h - 20]], fc);
  gHalo.selectAll("path").data(allFeatures).join("path").attr("class", "halo").attr("d", path);
  gPrec.selectAll("path").data(allFeatures, d => d.id).join("path").attr("class", "prec").attr("d", path)
    .on("mousemove", (ev, d) => showTip(ev, d)).on("mouseleave", hideTip)
    .on("click", (ev, d) => { state.selected = state.selected === d.id ? null : d.id; drawSelection(); state.tab === "up" ? renderUpDetail() : renderDetail(); });
  const wards = d3.groups(features, f => f.properties.ward).map(([w, fs]) => {
    const pts = fs.map(f => [path.centroid(f), path.area(f)]);
    const A = d3.sum(pts, p => p[1]);
    return { w, x: d3.sum(pts, p => p[0][0] * p[1]) / A, y: d3.sum(pts, p => p[0][1] * p[1]) / A };
  });
  const parishes = d3.groups(metroFeatures, f => f.properties.parish).map(([p, fs]) => {
    const pts = fs.map(f => [path.centroid(f), path.area(f)]).filter(p => Number.isFinite(p[1]) && Number.isFinite(p[0][0]));
    const A = d3.sum(pts, p => p[1]);
    return { w: p, big: true, x: d3.median(pts, p => p[0][0]), y: d3.median(pts, p => p[0][1]) };   // median precinct: sits where people live, not on the marsh
  });
  gLab.selectAll("text").data(wards.concat(parishes)).join("text").attr("class", d => "wlabel" + (d.big ? " plabel" : "")).attr("text-anchor", "middle")
    .attr("x", d => d.x).attr("y", d => d.y).text(d => d.big ? d.w : "W" + d.w);
  drawSelection();
}
const zoom = d3.zoom().scaleExtent([0.12, 24]).on("zoom", ev => {
  root.attr("transform", ev.transform);
  gLab.selectAll("text").style("font-size", d => (d.big ? 13 : 10) / ev.transform.k + "px").style("stroke-width", 3 / ev.transform.k + "px")
    .style("display", d => d.big ? (ev.transform.k < 2.5 ? null : "none") : (ev.transform.k < 0.6 ? "none" : null));
});
svg.call(zoom);
document.getElementById("zin").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1.6);
document.getElementById("zout").onclick = () => svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.6);
document.getElementById("zfit").onclick = () => fitCurrent(true);
function fitCurrent(animate) { if (state.tab === "trends") return; state.tab === "up" ? fitSet(upPrecincts(), animate) : fitRace(animate); }

function fitRace(animate) {
  const { race } = candInfo(state.cand);
  const fs = allFeatures.filter(f => race.precincts[f.id]);
  const t0 = animate ? svg.transition().duration(600) : svg;
  if (!fs.length || (!fs.some(f => isMetro(f.id)) && fs.length > features.length * 0.9)) { t0.call(zoom.transform, d3.zoomIdentity); return; }
  const [[x0, y0], [x1, y1]] = path.bounds({ type: "FeatureCollection", features: fs });
  const [w, h] = size();
  const k = Math.max(0.12, Math.min(24, 0.88 / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  t0.call(zoom.transform, d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}
function zoomTo(pid) {
  const f = featById.get(pid);
  const [[x0, y0], [x1, y1]] = path.bounds(f);
  const [w, h] = size();
  const k = Math.min(10, 0.25 / Math.max((x1 - x0) / w, (y1 - y0) / h));
  svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}
function drawSelection() {
  const f = state.selected ? featById.get(state.selected) : null;
  gSel.selectAll("path").data(f ? [f] : []).join("path").attr("class", "selring").attr("d", path);
}

const tip = document.getElementById("tip");
function showTip(ev, d) {
  if (state.tab === "up") return showUpTip(ev, d);
  const part = i => {
    const { race, idx, c } = candInfo(i);
    const s = precinctStats(race, idx, d.id);
    const name = esc(c.label.split(" – ")[0]);
    return s ? `${name} <b>${pctFmt(s.pct)}</b> (${fmt(s.v)}, ${ordinal(s.rank)})` : `${name}: not on ballot`;
  };
  tip.innerHTML = `${isMetro(d.id) ? esc(PARISH_NAME[d.id[0]]) + " precinct" : "Precinct"} <b>${esc(isMetro(d.id) ? d.id.slice(2) : d.id)}</b> · ` + part(state.cand) + (state.compare != null ? ` · ` + part(state.compare) : "");
  const box = svg.node().getBoundingClientRect();
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  if (x + tw > box.width - 8) x = ev.clientX - box.left - tw - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip() { tip.hidden = true; }

/* ---------- color ---------- */
function rampColors() {
  const cs = getComputedStyle(document.documentElement);
  return [0, 1, 2, 3, 4].map(i => cs.getPropertyValue(`--ramp-${i}`).trim());
}
let scale;
function rygColors() {
  const cs = getComputedStyle(document.documentElement);
  return ["--div-neg", "--div-mid", "--div-pos"].map(v => cs.getPropertyValue(v).trim());
}
let scaleMid = null;
function buildScale(values) {
  // red at the lowest precinct, light yellow at the median precinct, green at the highest
  const vs = values.filter(v => Number.isFinite(v)).sort(d3.ascending);
  let lo = vs[0] ?? 0, hi = vs[vs.length - 1] ?? 1, med = d3.median(vs) ?? (lo + hi) / 2;
  if (hi <= lo) hi = lo + (state.metric === "pct" ? 0.01 : 1);
  if (med <= lo || med >= hi) med = (lo + hi) / 2;
  scaleMid = med;
  scale = d3.scaleLinear().domain([lo, med, hi]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true);
}
function legW(lg) {
  const w = Math.round(lg.node().getBoundingClientRect().width) || 320;
  lg.attr("viewBox", `0 0 ${w} 44`);
  return w;
}
function drawLegend() {
  const lg = d3.select("#legend");
  lg.selectAll("*").remove();
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "lg");
  const [lo, , hi] = scale.domain();
  d3.range(0, 1.0001, 0.05).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", scale(lo + t * (hi - lo))));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#lg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, W]);
  const g = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  const lab = v => state.metric === "pct" ? (v * 100).toFixed(1) + "%" : fmt(Math.round(v));
  [[lo, "start", lab(lo) + " low"], [scaleMid, "middle", "median " + lab(scaleMid)], [hi, "end", "high " + lab(hi)]].forEach(([v, anchor, text]) => {
    const px = x(v);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    const mx = Math.min(W - 100, Math.max(100, px));
    g.append("text").attr("x", anchor === "middle" ? mx : px).attr("y", 15).attr("text-anchor", anchor)
      .attr("fill", "currentColor").style("font", font).text(text);
  });
  document.getElementById("legTitle").textContent = state.metric === "pct" ? "Vote share in precinct" : "Votes in precinct";
}

/* ---------- render ---------- */
function mappedStats(i) {
  const { race, idx } = candInfo(i);
  return new Map(Object.keys(race.precincts).filter(pid => featById.has(pid)).map(pid => [pid, precinctStats(race, idx, pid)]));
}
function eligibleCompares(i) {
  const a = candInfo(i), keysA = Object.keys(a.race.precincts).filter(p => featById.has(p));
  return order.filter(j => j !== i).filter(j => {
    const b = candInfo(j);
    return b.race.date === a.race.date && keysA.some(p => b.race.precincts[p]);
  });
}
function shortName(c) { return c.label.split(" – ")[0]; }

function renderChips(elig) {
  const box = document.getElementById("cmpChips");
  if (!elig.length) { box.innerHTML = `<span class="none">No other listed candidate shares precincts in this election.</span>`; return; }
  box.innerHTML = [`<button type="button" class="chip" data-i="" aria-pressed="${state.compare == null}">None</button>`]
    .concat(elig.map(j => { const { c, race } = candInfo(j);
      return `<button type="button" class="chip" data-i="${j}" aria-pressed="${state.compare === j}" title="${esc(race.title)}">${c.star ? STAR() : ""}${esc(c.label)} ${RT(race)}</button>`; })).join("");
  box.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
    state.compare = b.dataset.i === "" ? null : +b.dataset.i; render(false);
  }));
}

function voteTypes(race, idx) {
  // rows: label, votes for candidate, share among all choices, place
  const n = race.choices.length;
  const day = d3.range(n).map(k => d3.sum(Object.values(race.precincts), r => r[2 + k]));
  return [["Election day", day]].concat(race.unalloc.map(([l, v]) => [l, v])).map(([label, v]) => {
    const tot = d3.sum(v);
    return { label, votes: v[idx], share: tot ? v[idx] / tot : 0, place: 1 + v.filter(x => x > v[idx]).length, tot };
  }).filter(r => r.tot > 0);
}

function render(refit) { state.tab === "up" ? renderUp(refit) : state.tab === "trends" ? renderTrends() : renderPrev(refit); }
function renderPrev(refit) {
  const { c, race, idx, choice } = candInfo(state.cand);
  setButton();
  Object.entries(mBtns).forEach(([k, b]) => b.setAttribute("aria-pressed", k === state.metric));
  mBtns.pct.textContent = state.compare != null ? "Share gap (pts)" : "Vote share %";
  mBtns.votes.textContent = state.compare != null ? "Vote gap" : "Total votes";

  const elig = eligibleCompares(state.cand);
  if (state.compare != null && !elig.includes(state.compare)) state.compare = null;
  renderChips(elig);
  const cmp = state.compare != null ? candInfo(state.compare) : null;

  const statsA = mappedStats(state.cand);
  const statsB = cmp ? mappedStats(state.compare) : null;
  const keys = [...statsA.keys()].filter(p => !statsB || statsB.has(p));
  const val = cmp
    ? (p => state.metric === "pct" ? statsA.get(p).pct - statsB.get(p).pct : statsA.get(p).v - statsB.get(p).v)
    : (p => state.metric === "pct" ? statsA.get(p).pct : statsA.get(p).v);
  const vals = new Map(keys.map(p => [p, val(p)]));
  const legEnds = document.getElementById("legEnds");
  if (cmp) {
    const m0 = d3.max([...vals.values()], v => Math.abs(v)) || 1;
    const m = state.metric === "pct" ? Math.min(1, Math.ceil(m0 * 20) / 20) : d3.scaleLinear().domain([0, m0]).nice(4).domain()[1];
    const cs = getComputedStyle(document.documentElement);
    scale = d3.scaleDiverging(d3.interpolateRgbBasis(["--div-neg", "--div-mid", "--div-pos"].map(v => cs.getPropertyValue(v).trim()))).domain([-m, 0, m]);
    drawDivLegend(m);
    legEnds.hidden = false;
    legEnds.innerHTML = `<span><span class="dot" style="background:var(--div-neg)"></span>${esc(shortName(cmp.c))} ahead</span><span>${esc(shortName(c))} ahead<span class="dot" style="background:var(--div-pos);margin:0 0 0 6px"></span></span>`;
    document.getElementById("nodataTxt").textContent = "Precinct not on both ballots";
  } else {
    buildScale([...vals.values()]);
    drawLegend();
    legEnds.hidden = true;
    document.getElementById("nodataTxt").textContent = "Precinct not in this race";
  }
  gPrec.selectAll("path").classed("out", d => !vals.has(d.id)).attr("fill", d => vals.has(d.id) ? scale(vals.get(d.id)) : null);

  // summary
  const totals = raceTotals(race), all = totals[idx], allTotal = d3.sum(totals);
  const mapped = d3.sum([...statsA.values()], s => s.v);
  const unmappedIds = Object.keys(race.precincts).filter(pid => !featById.has(pid));
  const unmappedVotes = d3.sum(unmappedIds, pid => race.precincts[pid][2 + idx]);
  const won = [...statsA.values()].filter(s => s.won).length;
  const finish = 1 + totals.filter(t => t > all).length;
  const isMeasure = choice.name === "Yes" || choice.name === "No";
  document.getElementById("raceLine").innerHTML =
    `${c.star ? STAR() + " " : ""}<strong>${esc(isMeasure ? c.label : choice.name)}</strong>${choice.party ? " (" + choice.party + ")" : ""} · ${esc(race.title)} ${RT(race)} · ${dateLabel(race.date)} · ` +
    (isMeasure ? (finish === 1 ? "passed" : "failed") : race.multi ? `placed ${ordinal(finish)} of ${race.choices.length} in ${raceParishes(race).length > 1 ? "the parishes shown" : raceParishes(race)[0] + " Parish"}` : `finished ${ordinal(finish)} of ${race.choices.length}`);
  document.getElementById("sVotes").textContent = fmt(all);
  document.getElementById("sPct").textContent = pctFmt(all / allTotal);
  document.getElementById("sWon").textContent = `${won}/${statsA.size}`;

  // by vote type
  const vt = voteTypes(race, idx);
  document.getElementById("vtype").innerHTML =
    `<thead><tr><th>By vote type</th><th>Votes</th><th>Share</th><th>Place</th></tr></thead><tbody>` +
    vt.map(r => `<tr><td>${esc(r.label)}</td><td>${fmt(r.votes)}</td><td>${pctFmt(r.share)}</td><td>${ordinal(r.place)}</td></tr>`).join("") + `</tbody>`;

  // comparison summary
  const cs = document.getElementById("cmpSum");
  if (cmp) {
    const sumA = d3.sum(keys, p => statsA.get(p).v), totA = d3.sum(keys, p => statsA.get(p).total);
    const sumB = d3.sum(keys, p => statsB.get(p).v), totB = d3.sum(keys, p => statsB.get(p).total);
    const ahead = keys.filter(p => statsA.get(p).pct > statsB.get(p).pct).length;
    const evA = voteTypes(race, idx).find(r => r.label === "Early voting");
    const evB = voteTypes(cmp.race, cmp.idx).find(r => r.label === "Early voting");
    cs.hidden = false;
    cs.innerHTML = `<p class="eyebrow" style="margin:0">${esc(shortName(c))} vs ${esc(shortName(cmp.c))}</p>
      <div style="font-size:12.5px;color:var(--muted)">${keys.length} precincts on both ballots · ${esc(shortName(c))} had the higher share in <strong style="color:var(--ink)">${ahead}</strong> of them</div>
      <div class="vs">
        <span></span><span class="h">Shared precincts</span><span class="h">Early voting</span>
        <span><span class="dot" style="background:var(--div-pos)"></span>${c.star ? STAR() + " " : ""}${esc(c.label)}</span><span class="num">${pctFmt(totA ? sumA / totA : 0)}</span><span class="num">${evA ? pctFmt(evA.share) : "–"}</span>
        <span><span class="dot" style="background:var(--div-neg)"></span>${cmp.c.star ? STAR() + " " : ""}${esc(cmp.c.label)}</span><span class="num">${pctFmt(totB ? sumB / totB : 0)}</span><span class="num">${evB ? pctFmt(evB.share) : "–"}</span>
      </div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:6px">Shares are each candidate's share of their own race, so different races can be compared.</div>`;
  } else { cs.hidden = true; cs.innerHTML = ""; }

  let note = "";
  if (race.unalloc.length) note += `The state reports ${race.unalloc.map(u => u[0].toLowerCase()).join(" and ")} votes parish-wide, not by precinct, so they appear in the table above but not on the map. `;
  if (race.multi) { const ps = raceParishes(race); note += `This is a multi-parish race. Figures here cover ${listAnd(ps)} ${ps.length > 1 ? "parishes" : "Parish"}; any other parishes in the district are not included. `; }
  if (unmappedVotes) note += `${fmt(unmappedVotes)} votes were cast in precinct${unmappedIds.length > 1 ? "s" : ""} ${unmappedIds.map(pName).join(", ")}, which no longer exist${unmappedIds.length > 1 ? "" : "s"} on today's map. `;
  note += `The map shows the ${fmt(mapped)} votes counted in current precincts.`;
  document.getElementById("earlyNote").textContent = note;

  document.getElementById("mtT").innerHTML = `${c.star ? STAR("big") : ""}<span>${esc(c.label)}</span>` +
    (cmp ? `<span style="font-weight:500;color:var(--muted)">vs</span>${cmp.c.star ? STAR("big") : ""}<span>${esc(cmp.c.label)}</span>` : "");
  document.getElementById("mtS").textContent = cmp
    ? `${dateLabel(race.date)} · ${state.metric === "pct" ? "difference in vote share" : "difference in votes"}`
    : `${race.title} · ${raceType(race).long} · ${dateLabel(race.date)} · ${state.metric === "pct" ? "vote share" : "total votes"}`;

  const top = keys.slice().sort((a, b) => vals.get(b) - vals.get(a)).slice(0, 8);
  document.getElementById("topTitle").textContent = cmp
    ? `Where ${shortName(c)} ran furthest ahead of ${shortName(cmp.c)}`
    : `Strongest precincts by ${state.metric === "pct" ? "vote share" : "votes"}`;
  const ol = d3.select("#topList");
  ol.selectAll("li").remove();
  top.forEach((pid, i) => {
    const b = ol.append("li").append("button").attr("type", "button")
      .on("click", () => { state.selected = pid; drawSelection(); renderDetail(); zoomTo(pid); });
    b.append("span").attr("class", "rk").text(i + 1);
    b.append("span").text(pLabel(pid));
    const v = vals.get(pid);
    b.append("span").attr("class", "val").text(cmp
      ? (state.metric === "pct" ? (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + " pts" : (v >= 0 ? "+" : "−") + fmt(Math.abs(v)))
      : (state.metric === "pct" ? pctFmt(v) : fmt(v)));
  });

  renderDetail();
  if (refit) fitRace(true);
}

function drawDivLegend(m) {
  const lg = d3.select("#legend");
  lg.selectAll("*").remove();
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "lg");
  d3.range(0, 1.0001, 0.1).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", scale(-m + t * 2 * m)));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#lg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([-m, m]).range([0, W]);
  const g = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  [-m, -m / 2, 0, m / 2, m].forEach((t, i) => {
    const px = x(t);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    const lab = state.metric === "pct" ? Math.round(Math.abs(t) * 100) + " pts" : fmt(Math.abs(t));
    g.append("text").attr("x", px).attr("y", 15).attr("text-anchor", i === 0 ? "start" : i === 4 ? "end" : "middle")
      .attr("fill", "currentColor").style("font", font).text(t === 0 ? "even" : lab);
  });
  document.getElementById("legTitle").textContent = state.metric === "pct" ? "Gap in vote share" : "Gap in votes";
}

const avgCache = new Map();
function precinctAvg(i) {
  // vote-weighted share across every precinct in the race (election-day votes; early votes have no precinct)
  if (!avgCache.has(i)) {
    const { race, idx } = candInfo(i);
    const rows = Object.values(race.precincts);
    const v = d3.sum(rows, r => r[2 + idx]), tot = d3.sum(rows, r => d3.sum(r.slice(2)));
    const shares = Object.keys(race.precincts).filter(p => featById.has(p)).map(p => precinctStats(race, idx, p).pct).sort(d3.descending);
    avgCache.set(i, { avg: tot ? v / tot : 0, n: rows.length, shares });
  }
  return avgCache.get(i);
}
const pts = d => (d >= 0 ? "+" : "−") + Math.abs(d * 100).toFixed(1);

function renderDetail() {
  const el = document.getElementById("detail");
  const { race, idx } = candInfo(state.cand);
  const pid = state.selected;
  if (!pid) {
    el.innerHTML = `<p class="eyebrow">Precinct</p><p class="sub" style="margin:0">Click a precinct on the map to see every candidate's result there, and how the same precinct voted for each candidate in the list.</p>`;
    return;
  }
  const s = precinctStats(race, idx, pid);
  let html = `<p class="eyebrow">Precinct</p><h2>${esc(pName(pid))}</h2>`;
  if (!s) {
    html += `<p class="sub">${pWard(pid)} · not on the ballot for ${esc(race.title)}</p>`;
  } else {
    html += `<p class="sub">${pWard(pid)} · ${fmt(s.voted)} ballots of ${fmt(s.reg)} registered (${pctFmt(s.voted / s.reg)})</p>`;
    const A = precinctAvg(state.cand), d = s.pct - A.avg;
    const rk = 1 + A.shares.filter(x => x > s.pct).length;
    const hi = Math.max(s.pct, A.avg) * 1.15 || 1, X = v => (v / hi * 100).toFixed(1) + "%";
    html += `<div class="vsavg">
      <div class="delta ${d >= 0 ? "pos" : "neg"}">${pts(d)}<span style="font-size:13px;font-weight:600"> pts</span></div>
      <div class="l1"><b>${pctFmt(s.pct)}</b> here vs <b>${pctFmt(A.avg)}</b> average across ${A.n} precincts</div>
      <div class="l2">${ordinal(rk)} best of ${A.shares.length} precincts for ${esc(shortName(candInfo(state.cand).c))}</div>
      <div class="track" aria-hidden="true"><div class="rail"></div>
        <div class="seg2" style="left:${X(Math.min(s.pct, A.avg))};width:${((Math.abs(d)) / hi * 100).toFixed(1)}%;background:var(${d >= 0 ? "--div-pos" : "--div-neg"})"></div>
        <div class="avg" style="left:${X(A.avg)}" title="Average"></div><div class="here" style="left:${X(s.pct)}"></div></div>
    </div>`;
    const ord = race.choices.map((c, i) => ({ c, i, v: s.votes[i] })).sort((a, b) => b.v - a.v);
    const max = ord[0].v || 1;
    html += `<div class="bars">` + ord.map(o => `
      <div class="bar${o.i === idx ? " sel" : ""}">
        <div class="name"><div class="fill" style="width:${(o.v / max) * 100}%"></div><span>${esc(o.c.name)}</span></div>
        <div class="num">${fmt(o.v)}</div><div class="pct">${pctFmt(s.total ? o.v / s.total : 0)}</div>
      </div>`).join("") + `</div>`;
  }
  // every other candidate in the list, newest first, for this same precinct
  const rows = order.filter(i => i !== state.cand).map(i => ({ i, ...candInfo(i) }))
    .map(o => ({ ...o, s: precinctStats(o.race, o.idx, pid) }));
  const on = rows.filter(o => o.s), off = rows.length - on.length;
  html += `<div class="xrace"><p class="eyebrow">Same precinct, other candidates</p>`;
  html += on.map(o => `<button type="button" class="xrow" data-i="${o.i}">
      <span>${o.c.star ? STAR() : ""}</span>
      <span class="who">${esc(o.c.label)} ${RT(o.race)}<small>${esc(o.race.title)} · ${o.race.date.slice(0, 4)}</small></span>
      <span class="r">${pctFmt(o.s.pct)} · ${ordinal(o.s.rank)}<small class="${o.s.pct >= precinctAvg(o.i).avg ? "pos" : "neg"}">${pts(o.s.pct - precinctAvg(o.i).avg)} pts vs avg</small></span>
    </button>`).join("");
  if (!on.length) html += `<p class="xnone">No other listed candidate was on the ballot here.</p>`;
  else if (off) html += `<p class="xnone">${off} other listed candidate${off > 1 ? "s were" : " was"} not on the ballot here.</p>`;
  html += `</div>`;
  el.innerHTML = html;
  el.querySelectorAll(".xrow").forEach(b => b.addEventListener("click", () => { state.cand = +b.dataset.i; state.compare = null; save(); render(true); }));
}


/* ================= Upcoming elections ================= */
const DIST = DATA.dist;                        // precinct -> {h: house dist, c: council, g: congress, s: school board}
const SB_INFERRED = new Set(DATA.sbInferred);
const REG = (() => {
  const o = Object.fromEntries(Object.entries(races["67418"].precincts).map(([p, row]) => [p, row[0]]));
  // suburban precincts: registered voters from the most recent race that includes them
  DATA.races.slice().sort((a, b) => d3.descending(a.date, b.date)).forEach(r => Object.entries(r.precincts).forEach(([p, row]) => { if (isMetro(p) && o[p] == null && row[0]) o[p] = row[0]; }));
  return o;
})();
const uniq = k => [...new Set(Object.values(DIST).map(d => d[k]))];
const hds = uniq("h").sort((a, b) => a - b);
const UP = [
  { id: "house", label: "2027 – State House", key: "h", districts: hds, name: d => `House District ${d}` },
  { id: "dscc", label: "2028 – DSCC", key: "h", districts: hds, name: d => `House District ${d}`, note: "DSCC seats are elected by state House district, two offices per district." },
  { id: "opsb", label: "2028 – Orleans Parish School Board", key: "s", districts: ["1", "2", "3", "4", "5", "6", "7"], name: d => `District ${d}`,
    approx: d => d !== "2" && d !== "4" },
  { id: "cong", label: "2028 – US Congress", key: "g", districts: ["1", "2"], name: d => `LA-0${d}` },
  { id: "council", label: "2029 – City Council", key: "c", districts: ["AL1", "AL2", "A", "B", "C", "D", "E"],
    name: d => d.startsWith("AL") ? `At-Large Division ${d.slice(2)}` : `District ${d}` }
];
const upElection = () => UP.find(u => u.id === state.up.e);
// incumbent and open-seat status from the upcoming-races sheet (not for DSCC, which has two offices)
function upSeat(u, d) {
  const ty = u.id === "opsb" ? "sb" : u.id;
  if (ty === "dscc" || typeof JUR === "undefined" || !JUR[ty]) return "";
  const r = JUR[ty][d]; if (!r) return "";
  const f = jFlags(ty, d), pn = r.party === "D" ? "Democrat" : r.party === "R" ? "Republican" : "no party listed";
  return `<br>Incumbent: ${pn}` + (f.tl ? ` · <span class="flag">Open seat</span> (${esc(f.why)})` : "");
}

function upPrecincts() {
  const u = upElection(), d = state.up.d;
  if (!d) return [];
  if (d.startsWith("AL")) return features.map(f => f.id);
  return allFeatures.map(f => f.id).filter(p => DIST[p] && DIST[p][u.key] === d);
}

function setupUp() {
  const sel = document.getElementById("upElection");
  sel.innerHTML = UP.map(u => `<option value="${u.id}">${esc(u.label)}</option>`).join("");
  try { const s = JSON.parse(localStorage.getItem("nola-up-v1") || "{}"); if (UP.some(u => u.id === s.e)) { state.up.e = s.e; state.up.d = s.d || null; } if (s.group) state.up.group = s.group === "dsa" ? "dsa" : "all"; } catch (e) {}
  if (!state.up.d || !upElection().districts.includes(state.up.d)) state.up.d = upElection().districts[0];
  sel.value = state.up.e;
  sel.addEventListener("change", () => { state.up.e = sel.value; state.up.d = upElection().districts[0]; state.selected = null; saveUp(); renderUp(true); });
  document.querySelectorAll("[data-dw]").forEach(b => b.addEventListener("click", () => { dsccWeighted = b.dataset.dw === "1"; try { localStorage.setItem("nola-dscc-w", dsccWeighted ? "1" : "0"); } catch (e) {} for (const k in sumCache) delete sumCache[k]; renderUp(false); if (currentView === "summary") renderSum(); }));
  const gb = { dsa: document.getElementById("g-dsa"), all: document.getElementById("g-rec") };
  Object.entries(gb).forEach(([k, b]) => b.addEventListener("click", () => { state.up.group = k; saveUp(); renderUp(false); }));
  document.getElementById("tab-prev").addEventListener("click", () => setTab("prev", true));
  document.getElementById("tab-up").addEventListener("click", () => setTab("up", true));
  document.getElementById("tab-trends").addEventListener("click", () => setTab("trends", true));
  document.querySelector(".tabs").addEventListener("keydown", e => {
    const tabs = ["prev", "up", "trends"], i = tabs.indexOf(state.tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const t = tabs[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]; setTab(t, true); document.getElementById("tab-" + t).focus();
    }
  });
  setupTrends();
}
const saveUp = () => { try { localStorage.setItem("nola-up-v1", JSON.stringify(state.up)); } catch (e) {} };

function setTab(tab, animate, keepSelection) {
  state.tab = tab; if (!keepSelection) state.selected = null; drawSelection(); hideTip();
  [["prev", "prevView", "prevControls"], ["up", "upView", "upControls"], ["trends", "trendsView", "trendsControls"]].forEach(([k, v, c]) => {
    const b = document.getElementById("tab-" + k);
    b.setAttribute("aria-selected", tab === k); b.tabIndex = tab === k ? 0 : -1;
    document.getElementById(v).hidden = tab !== k;
    document.getElementById(c).hidden = tab !== k;
  });
  document.getElementById("prevLegend").hidden = tab !== "prev";
  document.getElementById("upLegendBox").hidden = tab !== "up";
  document.getElementById("trendsMain").hidden = tab !== "trends";
  document.querySelector(".mapwrap").hidden = tab === "trends";
  document.getElementById("elMain").classList.toggle("fixed", tab !== "trends");
  if (tab !== "trends") layout();
  render(false);
  if (tab !== "trends") fitCurrent(animate);
}

function fitSet(ids, animate) {
  const fs = ids.map(p => featById.get(p)).filter(Boolean);
  const t0 = animate ? svg.transition().duration(600) : svg;
  if (!fs.length || (!fs.some(f => isMetro(f.id)) && fs.length > features.length * 0.9)) { t0.call(zoom.transform, d3.zoomIdentity); return; }
  const [[x0, y0], [x1, y1]] = path.bounds({ type: "FeatureCollection", features: fs });
  const [w, h] = size();
  const k = Math.max(0.12, Math.min(24, 0.88 / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  t0.call(zoom.transform, d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}

// per-candidate performance inside a set of precincts
function perfIn(i, ids) {
  const { race, idx } = candInfo(i);
  const cov = ids.filter(p => race.precincts[p]);
  if (!cov.length) return null;
  let v = 0, tot = 0;
  cov.forEach(p => { const row = race.precincts[p]; v += row[2 + idx]; tot += d3.sum(row.slice(2)); });
  const share = tot ? v / tot : 0;
  return { cov: cov.length, v, share, avgVotes: v / cov.length, delta: share - precinctAvg(i).avg };
}
const inGroup = (i, g) => g === "all" ? true : g === "dsa" ? !!CANDIDATES[i].star : !CANDIDATES[i].star;

// precinct index: mean of (share here − candidate's average) across the group's candidates on the ballot there
// DSCC is a Democratic party race, so for it past all-Democrat races count fully and other race types count less
const RACE_W = { dd: 1, mx: 0.5, dr: 0.25, m: 0.25 };
let dsccWeighted = true;
try { if (localStorage.getItem("nola-dscc-w") === "0") dsccWeighted = false; } catch (e) {}
const raceW = i => RACE_W[raceType(candInfo(i).race).code] ?? 1;
const wmeanBy = (xs, f, w) => { const W = d3.sum(xs, w); return W ? d3.sum(xs, x => f(x) * w(x)) / W : d3.mean(xs, f); };
function precinctIndex(p, g, weighted) {
  const ds = [];
  CANDIDATES.forEach((c, i) => {
    if (!inGroup(i, g)) return;
    const { race, idx } = candInfo(i);
    const s = precinctStats(race, idx, p);
    if (s) ds.push({ d: s.pct - precinctAvg(i).avg, w: weighted ? raceW(i) : 1 });
  });
  return ds.length ? { mean: wmeanBy(ds, x => x.d, x => x.w), n: ds.length } : null;
}

function renderUp(refit) {
  const u = upElection(), d = state.up.d, ids = upPrecincts(), g = state.up.group, W = u.id === "dscc" && dsccWeighted;
  document.getElementById("upWeightRow").hidden = u.id !== "dscc";
  document.querySelectorAll("[data-dw]").forEach(b => b.setAttribute("aria-pressed", (b.dataset.dw === "1") === dsccWeighted));
  document.getElementById("g-dsa").setAttribute("aria-pressed", g === "dsa");
  document.getElementById("g-rec").setAttribute("aria-pressed", g === "all");
  // district chips
  const box = document.getElementById("upDistricts");
  // long district lists (State House, DSCC) use a dropdown; short ones keep chips
  const pick = x => { state.up.d = x; state.selected = null; drawSelection(); saveUp(); renderUp(true); };
  if (u.districts.length > 8) {
    box.innerHTML = `<select class="up-sel" id="upDistSel" aria-label="District" style="max-width:320px">${u.districts.map(x => `<option value="${x}"${x === d ? " selected" : ""}>${esc(u.name(x))}</option>`).join("")}</select>`;
    document.getElementById("upDistSel").addEventListener("change", e => pick(e.target.value));
  } else {
    box.innerHTML = u.districts.map(x => `<button type="button" class="chip dist" data-d="${x}" aria-pressed="${x === d}">${esc(u.name(x))}${u.approx && u.approx(x) ? ' <span class="approx">≈</span>' : ""}</button>`).join("");
    box.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => pick(b.dataset.d)));
  }

  // map
  const idx = new Map(ids.map(p => [p, precinctIndex(p, g, W)]).filter(([, v]) => v));
  const m0 = d3.max([...idx.values()], v => Math.abs(v.mean)) || 0.05;
  const m = Math.min(1, Math.ceil(m0 * 20) / 20);
  const cs = getComputedStyle(document.documentElement);
  scale = d3.scaleDiverging(d3.interpolateRgbBasis(["--div-neg", "--div-mid", "--div-pos"].map(v => cs.getPropertyValue(v).trim()))).domain([-m, 0, m]);
  gPrec.selectAll("path").classed("out", f => !idx.has(f.id)).attr("fill", f => idx.has(f.id) ? scale(idx.get(f.id).mean) : null);
  drawUpLegend(m);
  const gname = g === "dsa" ? "DSA" : "listed";
  document.getElementById("upLegEnds").innerHTML = `<span><span class="dot" style="background:var(--div-neg)"></span>Below their average</span><span>Above their average<span class="dot" style="background:var(--div-pos);margin:0 0 0 6px"></span></span>`;
  document.getElementById("upNodata").textContent = `Outside the district, or no ${gname} candidate on the ballot`;
  document.getElementById("mtT").innerHTML = `<span>${esc(u.name(d))}</span><span style="font-weight:500;color:var(--muted)">· ${esc(u.label)}</span>`;
  document.getElementById("mtS").textContent = `${g === "dsa" ? "DSA" : "DSA + recommended"} candidates' share in each precinct vs. their own average`;

  // summary
  const reg = d3.sum(ids, p => REG[p] || 0);
  const pars = [...new Set(ids.map(parishOf))];
  document.getElementById("upLine").innerHTML = `<strong>${esc(u.name(d))}</strong> · ${ids.length} precincts in ${listAnd(pars)} ${pars.length > 1 ? "parishes" : "Parish"} · ${fmt(reg)} registered voters` + upSeat(u, d) + (u.note ? `<br>${esc(u.note)}` : "");
  const rows = CANDIDATES.map((c, i) => ({ i, c, ...candInfo(i), p: perfIn(i, ids) })).filter(r => r.p);
  // cards use the same per-precinct figures as the Trends & data tables, averaged over the district's precincts
  const tmap = new Map(trendData(W).map(r => [r.p, r]));
  const card = (key, title, starred) => {
    const ps = ids.map(p => tmap.get(p)).filter(r => r && r[key]).map(r => r[key]);
    const cands = rows.filter(r => inGroup(r.i, key)).length;
    if (!ps.length) return `<div class="grpcard"><div class="h">${starred ? STAR() : ""}${title}</div><div class="k" style="margin-top:6px">No ${key === "dsa" ? "DSA" : "listed"} candidates on past ballots here</div></div>`;
    const sc = d3.mean(ps, x => x.score), sh = d3.mean(ps, x => x.share), vt = d3.mean(ps, x => x.votes);
    return `<div class="grpcard"><div class="h">${starred ? STAR() : ""}${title}</div>
      <div class="d ${sc >= 0 ? "pos" : "neg"}" style="font-size:20px;margin-top:4px">${pts(sc)} pts</div><div class="k">vs. their average · avg of ${ps.length} precinct${ps.length > 1 ? "s" : ""}</div>
      <div class="d" style="margin-top:6px">${pctFmt(sh)}</div><div class="k">average vote share · ${cands} candidate${cands > 1 ? "s" : ""}</div>
      <div class="d" style="margin-top:6px">${fmt(Math.round(vt))}</div><div class="k">average votes per precinct</div></div>`;
  };
  document.getElementById("upCards").innerHTML = card("dsa", "DSA candidates", true) + card("all", "DSA + recommended", false) +
    (W ? `<p class="note" style="grid-column:1/-1;margin:0">Weighted for DSCC: all-Democrat races count fully, mixed fields half, and D v R races and ballot measures a quarter. The candidate table shows each race's weight.</p>` : "");
  let warn = "";
  if (u.approx && u.approx(d)) warn += `<p class="warn">School Board District ${d}'s exact precincts aren't published in recent results (the seat was unopposed in 2024). This district is rebuilt from the 2020 School Board races, updated with the precincts used in the 2024 District 2 and 4 races and the changes the board adopted in 2023. About 19 precincts that left Districts 2 and 4 in 2023 were assigned to the nearest district, so edge precincts may be off.</p>`;
  if (u.key === "h" && d === "105") warn += `<p class="warn">Part of House District 105 is in Plaquemines Parish, which isn't mapped.</p>`;
  if (u.key === "g") warn += `<p class="warn">LA-0${d} also covers parishes beyond Orleans, Jefferson, St. Bernard and St. Tammany; only these four are mapped.</p>`;
  if (u.key === "h" && ids.some(isMetro)) warn += `<p class="note">Suburban precincts only have results for the 2022–2026 PSC, BESE, Congress and DSCC races (plus the 2026 Abita Springs mayor's race), so their scores rest on fewer candidates than Orleans precincts.</p>`;
  document.getElementById("upWarn").innerHTML = warn;

  // table
  const tbl = (key, title, starred) => {
    const rs = rows.filter(r => inGroup(r.i, key)).sort((a, b) => d3.descending(a.race.date, b.race.date));
    if (!rs.length) return "";
    return `<table class="cands"><caption>${starred ? STAR() + " " : ""}${title}</caption>
      <thead><tr><th>Candidate</th><th title="Precincts in this district where the candidate was on the ballot">Precincts</th><th>Share</th><th title="Share here minus the candidate's share across all their precincts">vs avg</th><th>Avg votes</th></tr></thead><tbody>` +
      rs.map(r => `<tr class="go" data-i="${r.i}" tabindex="0" title="Open in Previous elections">
        <td><span class="nm">${r.c.star ? STAR() : ""}${esc(r.c.label)} ${RT(r.race)}</span><small>${esc(r.race.title)} · ${r.race.date.slice(0, 4)}${W ? ` · counts ×${({ 1: "1", 0.5: "½", 0.25: "¼" })[raceW(r.i)]}` : ""}</small></td>
        <td>${r.p.cov}/${ids.length}</td><td>${pctFmt(r.p.share)}</td>
        <td class="${r.p.delta >= 0 ? "pos" : "neg"}">${pts(r.p.delta)}</td><td>${fmt(Math.round(r.p.avgVotes))}</td></tr>`).join("") + `</tbody></table>`;
  };
  const off = CANDIDATES.length - rows.length;
  const tw = document.getElementById("upTable");
  tw.innerHTML = tbl("dsa", "DSA candidates", true) + tbl("rec", "Recommended candidates", false) +
    (off ? `<p class="xnone">${off} listed candidate${off > 1 ? "s were" : " was"} never on the ballot in this district's precincts.</p>` : "");
  tw.querySelectorAll("tr.go").forEach(tr => {
    const go = () => { state.cand = +tr.dataset.i; state.compare = null; save(); setTab("prev", true); };
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });

  renderUpDetail();
  if (refit) fitSet(ids, true);
}

function drawUpLegend(m) {
  const lg = d3.select("#upLegend");
  lg.selectAll("*").remove();
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "ulg");
  d3.range(0, 1.0001, 0.1).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", scale(-m + t * 2 * m)));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#ulg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([-m, m]).range([0, W]);
  const gg = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  [-m, -m / 2, 0, m / 2, m].forEach((t, i) => {
    const px = x(t);
    gg.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    if (i % 2) return;   // label the ends and the middle only, so the text never collides
    gg.append("text").attr("x", px).attr("y", 15).attr("text-anchor", i === 0 ? "start" : i === 4 ? "end" : "middle")
      .attr("fill", "currentColor").style("font", font).text(t === 0 ? "average" : pts(t) + " pts");
  });
  document.getElementById("upLegTitle").textContent = `${state.up.group === "dsa" ? "DSA" : "DSA + recommended"} candidates vs. their average, by precinct`;
}

function showUpTip(ev, d) {
  const inside = upPrecincts().includes(d.id);
  const ix = inside ? precinctIndex(d.id, state.up.group) : null;
  tip.innerHTML = !inside ? `${esc(pLabel(d.id))} · outside ${esc(upElection().name(state.up.d))}`
    : ix ? `${esc(pLabel(d.id))} · ${state.up.group === "dsa" ? "DSA" : "DSA + rec."} <b>${pts(ix.mean)} pts</b> vs. average (${ix.n} candidate${ix.n > 1 ? "s" : ""})`
    : `${esc(pLabel(d.id))} · no ${state.up.group === "dsa" ? "DSA" : "listed"} candidate on the ballot`;
  const box = svg.node().getBoundingClientRect();
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  if (x + tw > box.width - 8) x = ev.clientX - box.left - tw - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}

function renderUpDetail() {
  const el = document.getElementById("upDetail");
  const pid = state.selected;
  if (!pid) { el.innerHTML = `<p class="eyebrow">Precinct</p><p class="sub" style="margin:0">Click a precinct to see how each listed candidate did there compared with their average.</p>`; return; }
  const inside = upPrecincts().includes(pid);
  const rows = order.map(i => ({ i, ...candInfo(i) })).map(o => ({ ...o, s: precinctStats(o.race, o.idx, pid) })).filter(o => o.s);
  const ixD = precinctIndex(pid, "dsa"), ixR = precinctIndex(pid, "all");
  let html = `<p class="eyebrow">Precinct</p><h2>${esc(pName(pid))}</h2><p class="sub">${pWard(pid)}${REG[pid] ? ` · ${fmt(REG[pid])} registered (2025)` : ""}${inside ? "" : " · outside this district"}</p>`;
  html += `<div class="grpcards" style="margin:0 0 8px">` +
    `<div class="grpcard"><div class="h">${STAR()}DSA</div><div class="d ${ixD && ixD.mean >= 0 ? "pos" : "neg"}">${ixD ? pts(ixD.mean) + " pts" : "–"}</div><div class="k">vs. average${ixD ? ` · ${ixD.n} cand.` : ""}</div></div>` +
    `<div class="grpcard"><div class="h">DSA + recommended</div><div class="d ${ixR && ixR.mean >= 0 ? "pos" : "neg"}">${ixR ? pts(ixR.mean) + " pts" : "–"}</div><div class="k">vs. average${ixR ? ` · ${ixR.n} cand.` : ""}</div></div></div>`;
  html += rows.map(o => `<button type="button" class="xrow" data-i="${o.i}">
      <span>${o.c.star ? STAR() : ""}</span>
      <span class="who">${esc(o.c.label)} ${RT(o.race)}<small>${esc(o.race.title)} · ${o.race.date.slice(0, 4)}</small></span>
      <span class="r">${pctFmt(o.s.pct)} · ${ordinal(o.s.rank)}<small class="${o.s.pct >= precinctAvg(o.i).avg ? "pos" : "neg"}">${pts(o.s.pct - precinctAvg(o.i).avg)} pts vs avg</small></span>
    </button>`).join("") || `<p class="xnone">No listed candidate was on the ballot here.</p>`;
  el.innerHTML = html;
  el.querySelectorAll(".xrow").forEach(b => b.addEventListener("click", () => { state.cand = +b.dataset.i; state.compare = null; save(); setTab("prev", true); }));
}


/* ================= Trends & data ================= */
const UPCOMING_COLS = [
  { e: "house", label: "State House '27 · DSCC '28", key: "h", fmt: d => `HD ${d}` },
  { e: "opsb", label: "School Board '28", key: "s", fmt: d => `OPSB ${d}${d !== "2" && d !== "4" ? " ≈" : ""}` },
  { e: "cong", label: "Congress '28", key: "g", fmt: d => `LA-0${d}` },
  { e: "council", label: "Council '29", key: "c", fmt: d => `District ${d}` }
];
state.trends = { dgroup: "dsa", type: "", dist: "", per: 25, page: { dsa: 0, all: 0 }, sort: { dsa: { k: "score", dir: -1 }, all: { k: "score", dir: -1 } } };
const TR_PAR = { O: "Orleans", J: "Jefferson", B: "St. Bernard", T: "St. Tammany" };
const parCode = p => isMetro(p) ? p[0] : "O";
const TR_TYPES = {
  p: { label: "Parish", name: d => TR_PAR[d] + " Parish", list: () => ["O", "J", "B", "T"] },
  h: { label: "State House / DSCC", name: d => `House District ${d}`, list: () => hds },
  s: { label: "School Board", name: d => `School Board District ${d}${d !== "2" && d !== "4" ? " (approx.)" : ""}`, list: () => ["1", "2", "3", "4", "5", "6", "7"] },
  g: { label: "Congress", name: d => `LA-0${d}`, list: () => ["1", "2"] },
  c: { label: "City Council", name: d => `Council District ${d}`, list: () => ["A", "B", "C", "D", "E"] }
};
// a district type with "All" districts keeps only precincts that vote in that kind of race (Council and School Board are Orleans-only)
const trInFilter = p => {
  const ty = state.trends.type, d = state.trends.dist;
  if (!ty) return true;
  if (ty === "p") return !d || parCode(p) === d;
  const v = (DIST[p] || {})[ty];
  return d ? v === d : !!v;
};

function gapsAt(p, g) {
  const out = [];
  CANDIDATES.forEach((c, i) => {
    if (g !== "all" && !inGroup(i, g)) return;
    const { race, idx } = candInfo(i);
    const s = precinctStats(race, idx, p);
    if (s) out.push({ i, gap: s.pct - precinctAvg(i).avg, share: s.pct, v: s.v, star: !!c.star });
  });
  return out;
}
let trendCache = null, trendCacheW = null;
function trendData(weighted) {
  if (weighted ? trendCacheW : trendCache) return weighted ? trendCacheW : trendCache;
  const w = x => weighted ? raceW(x.i) : 1;
  const rows = allFeatures.map(f => f.id).map(p => {
    const all = gapsAt(p, "all"), dsa = all.filter(x => x.star), rec = all.filter(x => !x.star);
    const agg = xs => xs.length ? { n: xs.length, score: wmeanBy(xs, x => x.gap, w), share: wmeanBy(xs, x => x.share, w), votes: wmeanBy(xs, x => x.v, w) } : null;
    return { p, ward: +p.split("-")[0], reg: REG[p] || 0, dsa: agg(dsa), rec: agg(rec), all: agg(all) };
  });
  if (weighted) trendCacheW = rows; else trendCache = rows;
  return rows;
}

function setupTrends() {
  const ty = document.getElementById("trType"), ds = document.getElementById("trDist");
  try { const s = JSON.parse(localStorage.getItem("nola-trends-v2") || "{}"); if (TR_TYPES[s.type]) { state.trends.type = s.type; state.trends.dist = s.dist || ""; } } catch (e) {}
  const saveT = () => { try { localStorage.setItem("nola-trends-v2", JSON.stringify({ type: state.trends.type, dist: state.trends.dist })); } catch (e) {} };
  const fillDist = () => {
    const T = TR_TYPES[state.trends.type];
    ds.disabled = !T;
    ds.innerHTML = `<option value="">All</option>` + (T ? T.list().map(d => `<option value="${d}">${esc(T.name(d))}</option>`).join("") : "");
    if (T && !T.list().includes(state.trends.dist)) state.trends.dist = "";
    ds.value = state.trends.dist;
  };
  ty.value = state.trends.type; fillDist();
  [["dsa", "dg-dsa"], ["all", "dg-all"]].forEach(([k, id]) => document.getElementById(id).addEventListener("click", () => { state.trends.dgroup = k; renderDistRank(); }));
  const reset = () => { state.trends.page = { dsa: 0, all: 0 }; saveT(); renderTrends(); };
  ty.addEventListener("change", () => { state.trends.type = ty.value; state.trends.dist = ""; fillDist(); reset(); });
  ds.addEventListener("change", () => { state.trends.dist = ds.value; reset(); });
  document.querySelectorAll(".copybtn[data-t]").forEach(b => b.addEventListener("click", () => {
    const csv = trendCsv(b.dataset.t), box = document.getElementById("trCsv");
    const fallback = () => { box.hidden = false; box.value = csv; box.focus(); box.select(); b.textContent = "Select and copy below"; };
    try {
      navigator.clipboard.writeText(csv).then(() => { b.textContent = "Copied"; box.hidden = true; setTimeout(() => b.textContent = "Copy as CSV", 1600); }, fallback);
    } catch (e) { fallback(); }
  }));
}

function sortedTrend(t) {
  const s = state.trends.sort[t];
  const base = trendData().filter(r => r[t] && trInFilter(r.p));
  const ranked = base.slice().sort((a, b) => b[t].score - a[t].score);
  const rankOf = new Map(ranked.map((r, i) => [r.p, i + 1]));
  const val = r => s.k === "reg" ? r.reg : s.k.startsWith("dsa.") ? (r.dsa ? r.dsa[s.k.slice(4)] : -Infinity) : s.k.startsWith("rec.") ? (r.rec ? r.rec[s.k.slice(4)] : -Infinity) : r[t][s.k];
  const rows = base.slice().sort((a, b) => s.k === "p" ? s.dir * a.p.localeCompare(b.p, undefined, { numeric: true }) : (s.dir * (val(a) - val(b)) || b[t].score - a[t].score));
  return { rows, rankOf, total: base.length };
}
function trendCsv(t) {
  const { rows, rankOf } = sortedTrend(t), q = s => /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const p1 = v => v == null ? "" : (v * 100).toFixed(1);
  const head = ["rank", "precinct", "parish", "vs_avg_pts", "avg_share_pct", "avg_votes", "races"].concat(t === "all" ? ["dsa_vs_avg_pts", "dsa_races", "rec_vs_avg_pts"] : []).concat(["registered"], UPCOMING_COLS.map(c => c.e));
  return [head.join(",")].concat(rows.map(r => { const x = r[t], d = DIST[r.p] || {};
    return [rankOf.get(r.p), q(isMetro(r.p) ? r.p.slice(2) : r.p), q(parishOf(r.p)), p1(x.score), p1(x.share), Math.round(x.votes), x.n]
      .concat(t === "all" ? [p1(r.dsa && r.dsa.score), r.dsa ? r.dsa.n : 0, p1(r.rec && r.rec.score)] : [])
      .concat([r.reg], UPCOMING_COLS.map(c => d[c.key] || "")).join(","); })).join("\n");
}
function pageOf(t) {
  const all = sortedTrend(t), per = state.trends.per, pages = Math.max(1, Math.ceil(all.rows.length / per));
  const pg = Math.min(state.trends.page[t], pages - 1); state.trends.page[t] = pg;
  return { ...all, page: pg, pages, rows: all.rows.slice(pg * per, pg * per + per), allRows: all.rows };
}

function futureCells(p) {
  const d = DIST[p] || {};
  return UPCOMING_COLS.map(c => {
    const v = d[c.key];
    if (!v) return `<td class="fut">–</td>`;
    const extra = c.e === "council" ? ` <button type="button" class="fpill" data-e="council" data-d="AL1" title="Both at-large seats are parish-wide">At-Large</button>` : "";
    return `<td class="fut"><button type="button" class="fpill" data-e="${c.e}" data-d="${v}">${c.fmt(v)}</button>${extra}</td>`;
  }).join("");
}

function scoreCell(x) {
  if (!x) return `<td>–</td>`;
  const m = 0.15, col = d3.scaleLinear().domain([-m, 0, m]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true)(x.score);
  return `<td><span class="score" style="background:${col}">${pts(x.score)} pts</span></td>`;
}

function trendTable(t) {
  const { rows, rankOf } = pageOf(t), s = state.trends.sort[t];
  const th = (k, label, cls, tip) => `<th class="${cls || ""}" ${s.k === k ? `aria-sort="${s.dir < 0 ? "descending" : "ascending"}"` : ""}${tip ? ` title="${tip}"` : ""}><button type="button" data-k="${k}">${label}</button></th>`;
  const both = t === "all";
  let h = `<table class="tt" data-t="${t}"><thead>`;
  h += `<tr><th></th><th class="l"></th>` + (both ? `<th class="grp" colspan="4">Combined</th><th class="grp" colspan="2">${STAR()} DSA</th><th class="grp">Rec.</th>` : `<th class="grp" colspan="4">${STAR()} DSA candidates</th>`) +
       `<th></th><th class="grp l" colspan="${UPCOMING_COLS.length}">Votes on next</th></tr>`;
  h += `<tr><th>#</th>${th("p", "Precinct", "l")}${th("score", "vs avg", "", "Average gap between each candidate's share here and their own average")}${th("share", "Avg share")}${th("votes", "Avg votes")}${th("n", "Races", "", "Listed candidates on this precinct's ballots")}` +
       (both ? `${th("dsa.score", "vs avg")}${th("dsa.n", "Races")}${th("rec.score", "vs avg")}` : "") +
       `${th("reg", "Registered")}` + UPCOMING_COLS.map(c => `<th class="l">${c.label}</th>`).join("") + `</tr></thead><tbody>`;
  h += rows.map(r => {
    const x = r[t];
    return `<tr><td class="rk">${rankOf.get(r.p)}</td><td class="pc l"><button type="button" data-p="${r.p}" title="Open in Previous elections">${esc(pName(r.p))}</button></td>` +
      scoreCell(x) + `<td>${pctFmt(x.share)}</td><td>${fmt(Math.round(x.votes))}</td><td>${x.n}</td>` +
      (both ? scoreCell(r.dsa) + `<td>${r.dsa ? r.dsa.n : 0}</td>` + scoreCell(r.rec) : "") +
      `<td>${fmt(r.reg)}</td>` + futureCells(r.p) + `</tr>`;
  }).join("");
  h += `</tbody></table>`;
  if (!rows.length) h = `<p class="xnone">No precincts in this district had a listed candidate on the ballot.</p>`;
  return h;
}

function wire(el, t) {
  el.querySelectorAll("th button").forEach(b => b.addEventListener("click", () => {
    const s = state.trends.sort[t], k = b.dataset.k;
    if (s.k === k) s.dir = -s.dir; else { s.k = k; s.dir = k === "p" ? 1 : -1; }
    state.trends.page[t] = 0;
    renderTrends();
  }));
  el.querySelectorAll("td.pc button").forEach(b => b.addEventListener("click", () => {
    const p = b.dataset.p;
    state.selected = p;
    setTab("prev", false, true);
    renderDetail();
    setTimeout(() => zoomTo(p), 320);   // after the map re-measures itself
  }));
  el.querySelectorAll(".fpill").forEach(b => b.addEventListener("click", () => {
    state.up.e = b.dataset.e; state.up.d = b.dataset.d; saveUp();
    document.getElementById("upElection").value = state.up.e;
    setTab("up", true);
  }));
}

function pager(t) {
  const el = document.getElementById(t === "dsa" ? "pgDsa" : "pgAll");
  const { page, pages, allRows } = pageOf(t), per = state.trends.per, n = allRows.length;
  if (!n) { el.innerHTML = ""; return; }
  el.innerHTML = `<span>Showing ${page * per + 1}–${Math.min(n, page * per + per)} of ${n} precincts</span>
    <span class="btns"><label>Per page <select data-act="per">${[25, 50, 100].map(v => `<option${v === per ? " selected" : ""}>${v}</option>`).join("")}</select></label>
    <button type="button" data-act="first" ${page === 0 ? "disabled" : ""} aria-label="First page">«</button>
    <button type="button" data-act="prev" ${page === 0 ? "disabled" : ""}>Previous</button>
    <span>Page ${page + 1} of ${pages}</span>
    <button type="button" data-act="next" ${page >= pages - 1 ? "disabled" : ""}>Next</button>
    <button type="button" data-act="last" ${page >= pages - 1 ? "disabled" : ""} aria-label="Last page">»</button></span>`;
  el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.act, P = state.trends.page;
    P[t] = a === "first" ? 0 : a === "last" ? pages - 1 : a === "prev" ? page - 1 : page + 1;
    renderTrends();
    document.getElementById(t === "dsa" ? "trDsa" : "trAll").scrollIntoView({ block: "nearest" });
  }));
  el.querySelector("select").addEventListener("change", e => { state.trends.per = +e.target.value; state.trends.page = { dsa: 0, all: 0 }; renderTrends(); });
}

function renderDistRank() {
  const g = state.trends.dgroup;
  document.getElementById("dg-dsa").setAttribute("aria-pressed", g === "dsa");
  document.getElementById("dg-all").setAttribute("aria-pressed", g === "all");
  const tmap = new Map(trendData().map(r => [r.p, r]));
  const groups = [["h", "house", "State House '27 · DSCC '28"], ["s", "opsb", "School Board '28"], ["c", "council", "City Council '29"], ["g", "cong", "Congress '28"]];
  const sets = groups.map(([key, e, title]) => {
    const T = TR_TYPES[key];
    const rows = T.list().map(d => {
      const ps = Object.keys(DIST).filter(p => DIST[p][key] === d).map(p => tmap.get(p)).filter(r => r && r[g]).map(r => r[g]);
      return { d, n: ps.length, score: ps.length ? d3.mean(ps, x => x.score) : null };
    }).filter(r => r.score != null).sort((a, b) => b.score - a.score);
    return { key, e, title, T, rows };
  });
  const m = Math.max(0.05, d3.max(sets.flatMap(s => s.rows), r => Math.abs(r.score)) || 0.05);
  const col = d3.scaleLinear().domain([-m, 0, m]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true);
  const box = document.getElementById("distRank");
  box.innerHTML = sets.map(s => `<p class="drgrp">${s.title}</p>` + s.rows.map((r, i) => {
    const w = Math.abs(r.score) / m * 50, left = r.score >= 0 ? 50 : 50 - w;
    const nm = s.key === "h" ? `HD ${r.d}` : s.key === "s" ? `District ${r.d}${r.d !== "2" && r.d !== "4" ? " ≈" : ""}` : s.key === "g" ? `LA-0${r.d}` : `District ${r.d}`;
    return `<button type="button" class="drrow" data-e="${s.e}" data-d="${r.d}" title="${esc(s.T.name(r.d))}: average of ${r.n} precincts">
      <span class="rk">${i + 1}</span><span class="nm">${nm}<small>${r.n} pct.</small></span>
      <span class="bar2" aria-hidden="true"><b></b><i style="left:${left}%;width:${w}%;background:${col(r.score)}"></i></span>
      <span class="sc ${r.score >= 0 ? "pos" : "neg"}">${pts(r.score)} pts</span></button>`;
  }).join("")).join("");
  box.querySelectorAll(".drrow").forEach(b => b.addEventListener("click", () => {
    state.up.e = b.dataset.e; state.up.d = b.dataset.d; state.up.group = g; saveUp();
    document.getElementById("upElection").value = state.up.e;
    setTab("up", true);
  }));
}

function renderTrends() {
  renderDistRank();
  const d = sortedTrend("dsa"), a = sortedTrend("all");
  const elD = document.getElementById("trDsa"), elA = document.getElementById("trAll");
  elD.innerHTML = trendTable("dsa"); wire(elD, "dsa"); pager("dsa");
  elA.innerHTML = trendTable("all"); wire(elA, "all"); pager("all");
  const T = TR_TYPES[state.trends.type], where = T && state.trends.dist ? `in ${T.name(state.trends.dist)}` : (state.trends.type === "c" || state.trends.type === "s") ? `in all ${state.trends.type === "c" ? "City Council" : "School Board"} districts (Orleans Parish)` : "across Orleans, Jefferson, St. Bernard and St. Tammany";
  document.getElementById("trSubD").textContent = `${d.total} precincts ${where} with a DSA candidate on a past ballot, ranked by how far DSA candidates ran above their own averages. Check the Races column: a precinct scored on one race is less reliable than one scored on several.`;
  document.getElementById("trSubA").textContent = `${a.total} precincts ${where}, ranked across all ${CANDIDATES.length} listed candidates (DSA and recommended).`;

  // summary (top 25 of the current filter, precincts with 2+ races)
  const N = 25, min = 2;
  const topD = trendData().filter(r => r.dsa && r.dsa.n >= min && trInFilter(r.p)).sort((x, y) => y.dsa.score - x.dsa.score).slice(0, N);
  const topA = trendData().filter(r => r.all && r.all.n >= min && trInFilter(r.p)).sort((x, y) => y.all.score - x.all.score).slice(0, N);
  const both = topD.filter(r => topA.some(q => q.p === r.p)).length;
  const wards = d3.rollups(topD.filter(r => !isMetro(r.p)), v => v.length, r => r.ward).sort((x, y) => y[1] - x[1]).slice(0, 3);
  const parz = d3.rollups(topD, v => v.length, r => parishOf(r.p)).sort((x, y) => y[1] - x[1]);
  const dist = (rows, key) => d3.rollups(rows, v => v.length, r => (DIST[r.p] || {})[key]).filter(x => x[0]).sort((x, y) => y[1] - x[1]);
  const hd = dist(topD, "h").slice(0, 3), cc = dist(topD, "c").slice(0, 2);
  const allD = trendData().filter(r => r.dsa && r.dsa.n >= min && trInFilter(r.p));
  const corr = (() => { const xs = trendData().filter(r => r.dsa && r.rec); if (xs.length < 5) return null; const mx = d3.mean(xs, r => r.dsa.score), my = d3.mean(xs, r => r.rec.score);
    const num = d3.sum(xs, r => (r.dsa.score - mx) * (r.rec.score - my)), den = Math.sqrt(d3.sum(xs, r => (r.dsa.score - mx) ** 2) * d3.sum(xs, r => (r.rec.score - my) ** 2)); return den ? num / den : null; })();
  document.getElementById("trSummary").innerHTML = `<div class="trstat">
    ${parz.length > 1 ? `<b>${parz.map(x => x[0]).join(", ")}</b><span>Parishes of the top ${topD.length} DSA precincts (${parz.map(x => x[1]).join(", ")})</span>` : ""}
    ${wards.length ? `<b>${wards.map(w => "W" + w[0]).join(", ")}</b><span>Orleans wards with the most of the top ${topD.length} DSA precincts (${wards.map(w => w[1]).join(", ")})</span>` : ""}
    <b>${hd.map(x => "HD " + x[0]).join(", ")}</b><span>House districts holding the most top DSA precincts (${hd.map(x => x[1]).join(", ")})</span>
    <b>${cc.map(x => "Dist. " + x[0]).join(", ")}</b><span>Council districts holding the most top DSA precincts (${cc.map(x => x[1]).join(", ")})</span>
    <b>${both}/${topD.length}</b><span>Top DSA precincts that are also in the combined top ${topD.length}</span>
    ${corr != null ? `<b>${corr >= 0 ? "+" : "−"}${Math.abs(corr).toFixed(2)}</b><span>Correlation between DSA and recommended precinct scores (1 = they rise and fall together)</span>` : ""}
    <b>${allD.filter(r => r.dsa.score > 0).length}/${allD.length}</b><span>Precincts where DSA candidates beat their averages</span>
  </div>`;
}


/* ================= Membership ================= */
const MEM = DATA.members;
function decodeRings(body) {
  return body.split("^").map(p => p.split("~").map(r => {
    let x = 0, y = 0;
    return r.split(" ").map(pt => { const [dx, dy] = pt.split(",").map(Number); x += dx; y += dy; return [x / 1e5, y / 1e5]; });
  }));
}
const zfeat = MEM.shapes.split("\n").map(line => {
  const [zip, pop, body] = line.split("|");
  const f = { type: "Feature", id: zip, properties: { zip, pop: +pop }, geometry: { type: "MultiPolygon", coordinates: decodeRings(body) } };
  f.geometry.coordinates.forEach(poly => poly.forEach(ring => { if (d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI) ring.reverse(); }));
  return f;
});
const zById = new Map(zfeat.map(f => [f.id, f]));
state.mem = { mode: "migs", metric: "rate", selected: null };
try { const s = JSON.parse(localStorage.getItem("nola-mem-v1") || "{}"); if (s.mode) state.mem.mode = s.mode; if (s.metric) state.mem.metric = s.metric; } catch (e) {}
const saveMem = () => { try { localStorage.setItem("nola-mem-v1", JSON.stringify({ mode: state.mem.mode, metric: state.mem.metric })); } catch (e) {} };
const mCount = z => { const c = MEM.counts[z]; return c ? (state.mem.mode === "migs" ? c[0] : c[1]) : 0; };
const mVal = z => { const f = zById.get(z), n = mCount(z); return state.mem.metric === "rate" ? (f && f.properties.pop > 0 ? n / f.properties.pop * 10000 : null) : n; };
const mFmt = v => v == null ? "–" : state.mem.metric === "rate" ? v.toFixed(1) : fmt(v);

const msvg = d3.select("#mmap"), mroot = msvg.append("g");
const gZ = mroot.append("g"), gZL = mroot.append("g"), gZS = mroot.append("g");
const mproj = d3.geoMercator(), mpath = d3.geoPath(mproj);
let mscale, mMid;
// map views: dense New Orleans core, the wider metro, or every mapped ZIP
const VIEW_SETS = {
  nola: () => zfeat.filter(f => (MEM.counts[f.id] || [0, 0])[1] >= 20),
  metro: () => zfeat.filter(f => (MEM.counts[f.id] || [0, 0])[1] >= 5 && !f.id.startsWith("39")),
  all: () => zfeat
};
state.mem.view = "nola";
const coreZips = () => VIEW_SETS.nola();
function msize() { return boxSize(msvg.node().parentNode); }
function mlayout() {
  const [w, h] = msize();
  mproj.fitExtent([[20, 70], [w - 20, h - 20]], { type: "FeatureCollection", features: coreZips() });
  gZ.selectAll("path").data(zfeat, d => d.id).join("path").attr("class", "zip").attr("d", mpath)
    .on("mousemove", mShowTip).on("mouseleave", () => document.getElementById("mtip").hidden = true)
    .on("click", (ev, d) => { state.mem.selected = state.mem.selected === d.id ? null : d.id; mrender(); });
  gZL.selectAll("text").data(zfeat, d => d.id).join("text").attr("class", "zlabel").attr("text-anchor", "middle")
    .attr("x", d => mpath.centroid(d)[0]).attr("y", d => mpath.centroid(d)[1] + 3).text(d => d.id);
}
const mzoom = d3.zoom().scaleExtent([0.3, 30]).on("zoom", ev => {
  mroot.attr("transform", ev.transform);
  gZL.selectAll("text").attr("font-size", 9.5 / ev.transform.k).style("stroke-width", 3 / ev.transform.k + "px")
    .attr("y", d => mpath.centroid(d)[1] + 3 / ev.transform.k)
    .style("display", d => { const [[x0, y0], [x1, y1]] = mpath.bounds(d); return (x1 - x0) * ev.transform.k > 34 ? null : "none"; });
});
msvg.call(mzoom);
document.getElementById("mzin").onclick = () => msvg.transition().duration(250).call(mzoom.scaleBy, 1.6);
document.getElementById("mzout").onclick = () => msvg.transition().duration(250).call(mzoom.scaleBy, 1 / 1.6);
function mFitView(animate) {
  const fs = VIEW_SETS[state.mem.view](), [w, h] = msize();
  const [[x0, y0], [x1, y1]] = mpath.bounds({ type: "FeatureCollection", features: fs });
  const k = Math.max(0.3, Math.min(30, 0.92 / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  const tr = d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  (animate ? msvg.transition().duration(500) : msvg).call(mzoom.transform, tr);
  document.querySelectorAll("[data-mv]").forEach(b => b.setAttribute("aria-pressed", b.dataset.mv === state.mem.view));
}
document.getElementById("mzfit").onclick = () => mFitView(true);
document.querySelectorAll("[data-mv]").forEach(b => b.addEventListener("click", () => { state.mem.view = b.dataset.mv; mFitView(true); }));

function mShowTip(ev, d) {
  const c = MEM.counts[d.id] || [0, 0], pop = d.properties.pop, tip = document.getElementById("mtip");
  const per = n => pop > 0 ? (n / pop * 10000).toFixed(1) : "–";
  tip.innerHTML = `ZIP <b>${d.id}</b> · MIGS <b>${c[0]}</b> · MIGS + Lapsed <b>${c[1]}</b> · ${per(mCount(d.id))} per 10k residents`;
  const box = msvg.node().getBoundingClientRect();
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  tip.hidden = false;
  if (x + tip.offsetWidth > box.width - 8) x = ev.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}

function mrender() {
  const { mode, metric } = state.mem;
  [["mm-migs", mode === "migs"], ["mm-all", mode === "all"], ["mx-rate", metric === "rate"], ["mx-count", metric === "count"]]
    .forEach(([id, on]) => document.getElementById(id).setAttribute("aria-pressed", on));
  const vals = zfeat.map(f => mVal(f.id)).filter(v => v != null).sort(d3.ascending);
  let lo = vals[0] ?? 0, hi = vals[vals.length - 1] ?? 1, med = d3.median(vals) ?? 0;
  if (hi <= lo) hi = lo + 1; if (med <= lo || med >= hi) med = (lo + hi) / 2;
  mMid = med;
  mscale = d3.scaleLinear().domain([lo, med, hi]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true);
  gZ.selectAll("path").attr("fill", d => { const v = mVal(d.id); return v == null ? "var(--empty)" : mscale(v); });
  const f = state.mem.selected ? zById.get(state.mem.selected) : null;
  gZS.selectAll("path").data(f ? [f] : []).join("path").attr("class", "selring").attr("d", mpath);
  mDrawLegend(lo, med, hi);
  const label = mode === "migs" ? "Members in good standing" : "MIGS + lapsed members";
  document.getElementById("mmT").textContent = label;
  document.getElementById("mmS").textContent = metric === "rate" ? "per 10,000 residents (2020 Census)" : "member count";
  document.getElementById("mLegTitle").textContent = metric === "rate" ? `${label} per 10,000 residents` : `${label} per ZIP code`;

  // totals
  const all = Object.values(MEM.counts), migs = d3.sum(all, c => c[0]), tot = d3.sum(all, c => c[1]);
  document.getElementById("memMigs").textContent = fmt(migs);
  document.getElementById("memLapsed").textContent = fmt(tot - migs);
  document.getElementById("memTotal").textContent = fmt(tot);
  const unm = Object.entries(MEM.counts).filter(([z]) => !zById.has(z));
  const unmN = d3.sum(unm, ([, c]) => mode === "migs" ? c[0] : c[1]);
  const top5 = Object.entries(MEM.counts).sort((a, b) => (mode === "migs" ? b[1][0] - a[1][0] : b[1][1] - a[1][1])).slice(0, 5);
  const top5n = d3.sum(top5, ([, c]) => mode === "migs" ? c[0] : c[1]);
  document.getElementById("memNote").innerHTML =
    `${pctFmt(migs / tot)} of members on the list are in good standing. The five largest ZIP codes (${top5.map(([z]) => z).join(", ")}) hold ${pctFmt(top5n / (mode === "migs" ? migs : tot))} of ${mode === "migs" ? "members in good standing" : "all listed members"}.` +
    (unm.length ? `<br>Not on the map: ${unm.map(([z, c]) => `${z} (${mode === "migs" ? c[0] : c[1]})`).join(", ")}, ${fmt(unmN)} member${unmN === 1 ? "" : "s"} in P.O.-box or out-of-state ZIP codes.` : "");

  // detail
  const det = document.getElementById("memDetail");
  if (!f) det.innerHTML = `<p class="eyebrow">ZIP code</p><p class="sub" style="margin:0">Click a ZIP code on the map or in the table for its details.</p>`;
  else {
    const c = MEM.counts[f.id] || [0, 0], pop = f.properties.pop;
    const rankOf = arr => 1 + arr.filter(v => v > mVal(f.id)).length;
    det.innerHTML = `<p class="eyebrow">ZIP code</p><h2>${f.id}</h2><p class="sub">${fmt(pop)} residents (2020)</p>
      <table class="vtype"><thead><tr><th></th><th>Members</th><th>Per 10k</th></tr></thead><tbody>
      <tr><td>In good standing</td><td>${c[0]}</td><td>${pop ? (c[0] / pop * 10000).toFixed(1) : "–"}</td></tr>
      <tr><td>Lapsed</td><td>${c[1] - c[0]}</td><td>${pop ? ((c[1] - c[0]) / pop * 10000).toFixed(1) : "–"}</td></tr>
      <tr><td>MIGS + Lapsed</td><td>${c[1]}</td><td>${pop ? (c[1] / pop * 10000).toFixed(1) : "–"}</td></tr></tbody></table>
      <p class="note">${c[1] ? `${pctFmt(c[0] / c[1])} of members here are in good standing. ` : ""}Ranks ${ordinal(rankOf(vals))} of ${vals.length} mapped ZIP codes on the current measure.</p>`;
  }

  // top table
  const rows = zfeat.map(f => ({ z: f.id, c: MEM.counts[f.id] || [0, 0], v: mVal(f.id) })).filter(r => r.v != null).sort((a, b) => b.v - a.v).slice(0, 20);
  document.getElementById("memTopTitle").textContent = `Top 20 ZIP codes by ${metric === "rate" ? "members per 10,000 residents" : "member count"}`;
  const box = document.getElementById("memTop");
  box.innerHTML = `<table class="mt"><thead><tr><th>ZIP</th><th>MIGS</th><th>+ Lapsed</th><th>${metric === "rate" ? "Per 10k" : "Count"}</th></tr></thead><tbody>` +
    rows.map(r => `<tr data-z="${r.z}" tabindex="0" class="${r.z === state.mem.selected ? "sel" : ""}"><td>${r.z}</td><td>${r.c[0]}</td><td>${r.c[1]}</td><td>${mFmt(r.v)}</td></tr>`).join("") + `</tbody></table>`;
  box.querySelectorAll("tr[data-z]").forEach(tr => {
    const go = () => { state.mem.selected = tr.dataset.z; mrender(); mZoomTo(tr.dataset.z); };
    tr.addEventListener("click", go); tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
}
function mZoomTo(z) {
  const f = zById.get(z); if (!f) return;
  const [[x0, y0], [x1, y1]] = mpath.bounds(f), [w, h] = msize();
  const k = Math.min(8, 0.4 / Math.max((x1 - x0) / w, (y1 - y0) / h));
  msvg.transition().duration(600).call(mzoom.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}
function mDrawLegend(lo, med, hi) {
  const lg = d3.select("#mLegend");
  lg.selectAll("*").remove();
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "mlg");
  d3.range(0, 1.0001, 0.05).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", mscale(lo + t * (hi - lo))));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#mlg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, W]), g = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  [[lo, "start", mFmt(lo) + " low"], [med, "middle", "median " + mFmt(med)], [hi, "end", "high " + mFmt(hi)]].forEach(([v, a, text]) => {
    const px = x(v);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    g.append("text").attr("x", a === "middle" ? Math.min(W - 70, Math.max(70, px)) : px).attr("y", 15).attr("text-anchor", a)
      .attr("fill", "currentColor").style("font", font).text(text);
  });
}
[["mm-migs", () => state.mem.mode = "migs"], ["mm-all", () => state.mem.mode = "all"], ["mx-rate", () => state.mem.metric = "rate"], ["mx-count", () => state.mem.metric = "count"]]
  .forEach(([id, fn]) => document.getElementById(id).addEventListener("click", () => { fn(); saveMem(); mrender(); }));
let mrt;
new ResizeObserver(() => { if (currentView !== "membership" || state.jur.tab !== "zip") return; clearTimeout(mrt); mrt = setTimeout(() => { mlayout(); mrender(); mFitView(false); }, 120); }).observe(msvg.node().parentNode);
let memReady = false;
function showMembership() { memReady = true; setMemTab(state.jur ? state.jur.tab : "zip"); }


/* ================= Membership: Jurisdictions ================= */
const JUR = DATA.juris.data;
const jShapes = new Map();
DATA.juris.shapes.split("\n").forEach(line => {
  const [k, body] = line.split("|");
  const f = { type: "Feature", id: k, geometry: { type: "MultiPolygon", coordinates: decodeRings(body) } };
  f.geometry.coordinates.forEach(poly => poly.forEach(ring => { if (d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI) ring.reverse(); }));
  jShapes.set(k, f);
});
const JT = {
  house: { label: "State House", year: 2027, up: "house", key: "h", src: "H", name: d => `House District ${d}`, short: d => d },
  dscc: { label: "DSCC", year: 2028, up: "dscc", key: "h", src: "H", name: d => `DSCC, House District ${d}`, short: d => d },
  sb: { label: "School Board", year: 2028, up: "opsb", key: "s", name: d => `School Board District ${d}`, short: d => d, approx: d => d !== "2" && d !== "4" },
  cong: { label: "US Congress", year: 2028, up: "cong", key: "g", src: "C", name: d => `Congressional District ${d} (LA-0${d})`, short: d => `LA-0${d}` },
  council: { label: "City Council", year: 2029, up: "council", key: "c", name: d => d.startsWith("AL") ? `Council At-Large, Division ${d.slice(2)}` : `Council District ${d}`, short: d => d.startsWith("AL") ? `At-Large ${d.slice(2)}` : d }
};
state.jur = { type: "house", measure: "migs", filter: "all", view: "nola", selected: null, tab: "zip", showTgt: false };
try { const s = JSON.parse(localStorage.getItem("nola-jur-v1") || "{}"); if (JT[s.type]) state.jur.type = s.type; if (s.measure) state.jur.measure = s.measure; if (s.tab) state.jur.tab = s.tab; } catch (e) {}
const saveJur = () => { try { localStorage.setItem("nola-jur-v1", JSON.stringify({ type: state.jur.type, measure: state.jur.measure, tab: state.jur.tab })); } catch (e) {} };

const jRec = (type, d) => JUR[type][d];
const jFlags = (type, d) => {
  const r = jRec(type, d); if (!r) return { dsa: false, former: false, target: false, tl: false };
  if (type === "dscc") { const o = Object.values(r.offices); return { dsa: o.some(x => x.dsa === "Y"), former: o.some(x => x.dsa === "Former"), target: o.some(x => x.target), tl: o.some(x => x.tl) }; }
  return { dsa: r.dsa === "Y", former: r.dsa === "Former", target: r.target, tl: r.tl || !!r.open, why: r.open || (r.tl ? "term-limited" : "") };
};
const jVal = (type, d) => { const r = jRec(type, d); if (!r) return null; return state.jur.measure === "migs" ? r.migs : state.jur.measure === "all" ? r.all : (r.int ?? 0); };
const jPass = (type, d) => { const f = jFlags(type, d); return state.jur.filter === "all" || (state.jur.filter === "target" ? f.target : f.dsa); };
const jMapDistricts = type => Object.keys(JUR[type]).filter(d => !d.startsWith("AL"));   // at-large seats are parish-wide; listed, not drawn
const jOrleansPrecincts = (type, d) => d.startsWith("AL") ? features.map(f => f.id) : features.map(f => f.id).filter(p => DIST[p] && DIST[p][JT[type].key] === d);

const jsvg = d3.select("#jmap"), jroot = jsvg.append("g");
const gJ = jroot.append("g"), gJL = jroot.append("g"), gJS = jroot.append("g");
const jproj = d3.geoMercator(), jpath = d3.geoPath(jproj);
let jscale, jMid;
function jsize() { return boxSize(jsvg.node().parentNode); }
// one drawable item per district (shape-based) or per precinct (precinct-based districts)
function jItems() {
  const T = JT[state.jur.type];
  if (T.src) return jMapDistricts(state.jur.type).map(d => ({ id: T.src + d, d, f: jShapes.get(T.src + d) })).filter(x => x.f);
  return features.map(f => ({ id: f.id, d: (DIST[f.id] || {})[T.key], f, pr: true })).filter(x => x.d && JUR[state.jur.type][x.d]);
}
function jLabelPoints() {
  const T = JT[state.jur.type], pts = new Map();
  jItems().forEach(it => {
    const a = jpath.area(it.f), c = jpath.centroid(it.f);
    if (!Number.isFinite(a) || !Number.isFinite(c[0])) return;
    const p = pts.get(it.d) || { x: 0, y: 0, a: 0 };
    p.x += c[0] * a; p.y += c[1] * a; p.a += a; pts.set(it.d, p);
  });
  return [...pts].map(([d, p]) => ({ d, x: p.x / p.a, y: p.y / p.a }));
}
function jlayout() {
  const [w, h] = jsize();
  jproj.fitExtent([[20, 70], [w - 20, h - 20]], { type: "FeatureCollection", features });
}
const jzoom = d3.zoom().scaleExtent([0.15, 30]).on("zoom", ev => {
  jroot.attr("transform", ev.transform);
  const k = ev.transform.k;
  gJL.selectAll("g.jl1").attr("transform", d => `translate(${d.x},${d.y}) scale(${1 / k})`);
});
jsvg.call(jzoom);
document.getElementById("jzin").onclick = () => jsvg.transition().duration(250).call(jzoom.scaleBy, 1.6);
document.getElementById("jzout").onclick = () => jsvg.transition().duration(250).call(jzoom.scaleBy, 1 / 1.6);
function jFitView(animate) {
  const [w, h] = jsize();
  const fs = state.jur.view === "nola" || !JT[state.jur.type].src ? features : jItems().map(x => x.f);
  const [[x0, y0], [x1, y1]] = jpath.bounds({ type: "FeatureCollection", features: fs });
  const k = Math.max(0.15, Math.min(30, 0.92 / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  const tr = d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  (animate ? jsvg.transition().duration(500) : jsvg).call(jzoom.transform, tr);
  document.querySelectorAll("[data-jv]").forEach(b => b.setAttribute("aria-pressed", b.dataset.jv === state.jur.view));
}
document.getElementById("jzfit").onclick = () => jFitView(true);

const ptyPill = p => `<span class="pty ${p === "D" || p === "R" ? p : "N"}" title="${p === "D" ? "Democrat" : p === "R" ? "Republican" : "No incumbent party listed"}">${p || "–"}</span>`;
function jTags(type, d) {
  const f = jFlags(type, d), r = jRec(type, d); let h = "";
  const st = state.jur.showTgt;
  const pn = p => p === "D" ? "Dem" : p === "R" ? "Rep" : "no party listed";
  // DSCC seats are always held by Democrats, so only DSA-held offices (and targets, when shown) get a tag
  if (type === "dscc") h += Object.entries(r.offices).map(([o, x]) =>
    (x.dsa === "Y" ? `<span class="flag dsa" title="DSCC Office ${o} is held by a DSA member">Office ${o} · DSA</span>` : "") +
    (st && x.target ? `<span class="tgt" title="DSCC Office ${o} is a target">${o} TARGET</span>` : "")).join("");
  else h += ptyPill(r.party);
  if (type !== "dscc") {
    if (f.dsa) h += `<span class="flag dsa">DSA</span>`;
    if (f.former) h += `<span class="flag dsa">Former DSA</span>`;
    if (st && f.target) h += `<span class="tgt">TARGET</span>`;
    if (f.tl) h += `<span class="flag" title="${f.why}">${f.why === "term-limited" ? "Term-limited" : "Open seat"}</span>`;
  } else if (st && f.target) h += `<span class="tgt">TARGET</span>`;
  return h;
}

function jShowTip(ev, it) {
  const type = state.jur.type, T = JT[type], r = jRec(type, it.d), tip = document.getElementById("jtip");
  tip.innerHTML = `<b>${esc(T.name(it.d))}</b> · MIGS <b>${r.migs}</b> · + Lapsed <b>${r.all}</b> · Interested <b>${r.int ?? 0}</b>` + (it.pr ? ` · precinct ${it.id}` : "");
  const box = jsvg.node().getBoundingClientRect();
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  tip.hidden = false;
  if (x + tip.offsetWidth > box.width - 8) x = ev.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}

function jrender() {
  const type = state.jur.type, T = JT[type], m = state.jur.measure;
  document.getElementById("jurType").value = type;
  [["jm-migs", "migs"], ["jm-all", "all"], ["jm-int", "int"]].forEach(([id, k]) => document.getElementById(id).setAttribute("aria-pressed", m === k));
  document.querySelectorAll("[data-jf]").forEach(b => b.setAttribute("aria-pressed", b.dataset.jf === state.jur.filter));
  document.querySelectorAll("[data-jv]").forEach(b => { b.setAttribute("aria-pressed", b.dataset.jv === state.jur.view); b.disabled = !T.src && b.dataset.jv === "all"; });
  const ds = jMapDistricts(type);
  const vals = ds.map(d => jVal(type, d)).filter(v => v != null).sort(d3.ascending);
  let lo = vals[0] ?? 0, hi = vals[vals.length - 1] ?? 1, med = d3.median(vals) ?? 0;
  if (hi <= lo) hi = lo + 1; if (med <= lo || med >= hi) med = (lo + hi) / 2;
  jMid = med;
  jscale = d3.scaleLinear().domain([lo, med, hi]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true);
  const items = jItems();
  gJ.selectAll("path").data(items, it => it.id).join("path")
    .attr("class", it => "jd" + (it.pr ? " pr" : "") + (jPass(type, it.d) ? "" : " dim"))
    .attr("d", it => jpath(it.f))
    .attr("fill", it => jscale(jVal(type, it.d)))
    .style("stroke", it => it.pr ? jscale(jVal(type, it.d)) : null)
    .on("mousemove", jShowTip).on("mouseleave", () => document.getElementById("jtip").hidden = true)
    .on("click", (ev, it) => { state.jur.selected = state.jur.selected === it.d ? null : it.d; jrender(); });
  // labels: district name, red star if DSA-held, TARGET pill if targeted
  const k = d3.zoomTransform(jsvg.node()).k;
  const labs = jLabelPoints();
  gJL.selectAll("g.jl1").data(labs, l => l.d).join(enter => {
    const g = enter.append("g").attr("class", "jl1");
    g.append("text").attr("class", "jlab").attr("text-anchor", "middle");
    g.append("use").attr("class", "jstar").attr("href", "#star").attr("width", 11).attr("height", 11);
    g.append("rect").attr("class", "jtgt").attr("rx", 2).attr("height", 10).attr("width", 34).attr("x", -17).attr("y", 5);
    g.append("text").attr("class", "jtgt-t").attr("text-anchor", "middle").attr("y", 12.5).text("TARGET");
    return g;
  }).attr("transform", l => `translate(${l.x},${l.y}) scale(${1 / k})`)
    .each(function (l) {
      const g = d3.select(this), f = jFlags(type, l.d), pass = jPass(type, l.d);
      const txt = g.select("text.jlab").text(T.short(l.d)).attr("y", 3).classed("dim", !pass);
      const w = (T.short(l.d).length * 6.6);
      g.select("use").attr("x", -w / 2 - 13).attr("y", -6).style("display", f.dsa ? null : "none").attr("opacity", pass ? 1 : .35);
      g.selectAll("rect.jtgt, text.jtgt-t").style("display", state.jur.showTgt && f.target ? null : "none").attr("opacity", pass ? 1 : .35);
    });
  // selection
  const sel = state.jur.selected;
  const selFs = sel ? (T.src ? (jShapes.get(T.src + sel) ? [jShapes.get(T.src + sel)] : []) : (sel.startsWith("AL") ? features : features.filter(f => (DIST[f.id] || {})[T.key] === sel))) : [];
  gJS.selectAll("path").data(selFs).join("path").attr("class", "selring").attr("d", jpath);
  jDrawLegend(lo, med, hi);
  document.getElementById("jLegTgt").hidden = !state.jur.showTgt;
  document.getElementById("jTgtToggle").setAttribute("aria-pressed", state.jur.showTgt);
  const ml = m === "migs" ? "Members in good standing" : m === "all" ? "MIGS + lapsed members" : "Interested contacts";
  document.getElementById("jmT").textContent = `${T.year} ${T.label}`;
  document.getElementById("jmS").textContent = `${ml} per district` + (type === "council" ? " · at-large seats are listed, not drawn" : "");
  document.getElementById("jLegTitle").textContent = `${ml} per district`;

  // summary
  const all = Object.keys(JUR[type]);
  const tg = all.filter(d => jFlags(type, d).target), dsa = all.filter(d => jFlags(type, d).dsa);
  const top = all.slice().sort((a, b) => (jVal(type, b) ?? -1) - (jVal(type, a) ?? -1)).slice(0, 3);
  document.getElementById("jurSumTitle").textContent = `${T.year} ${T.label}`;
  document.getElementById("jurSummary").innerHTML = `<div class="trstat">
    <b>${all.length}</b><span>districts on the sheet${T.src ? " (including districts outside Orleans Parish)" : ""}</span>
    <b>${tg.length}</b><span>targets${tg.length ? ": " + tg.map(d => esc(T.short(d))).join(", ") : ""}</span>
    <b>${dsa.length}</b><span>held by DSA${dsa.length ? ": " + dsa.map(d => esc(T.short(d))).join(", ") : ""}</span>
    <b>${top.map(d => esc(T.short(d))).join(", ")}</b><span>most ${m === "int" ? "interested contacts" : "members"}</span>
  </div>` + (type === "sb" ? `<p class="note">School Board districts 1, 3, 5, 6 and 7 are approximate (see Election Data, Upcoming elections).</p>` : "") +
  (type === "dscc" ? `<p class="note">Each House district elects two DSCC members (Offices A and B); member counts are per district.</p>` : "");

  // detail
  const det = document.getElementById("jurDetail");
  if (!sel || !jRec(type, sel)) det.innerHTML = `<p class="eyebrow">District</p><p class="sub" style="margin:0">Click a district on the map or in the list for incumbents and member counts.</p>`;
  else {
    const r = jRec(type, sel), orl = jOrleansPrecincts(type, sel);
    const upOK = orl.length && (type !== "house" && type !== "dscc" || UP.find(u => u.id === T.up).districts.includes(sel));
    const pfull = p => p === "D" ? "Democrat" : p === "R" ? "Republican" : "No party listed";
    const f = jFlags(type, sel);
    let inc;
    if (type === "dscc") {
      const st = state.jur.showTgt;
      const offs = Object.entries(r.offices);
      inc = `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px">` +
        offs.map(([o, x]) => `<div style="font-size:13px">Office ${o}${x.dsa === "Y" ? ` <span class="flag dsa">DSA</span>` : ""}${st && x.target ? ` <span class="tgt">TARGET</span>` : ""}</div>`).join("") +
        (offs.some(([, x]) => x.dsa === "Y") ? "" : `<div class="sub" style="margin:0">Neither office is held by a DSA member.</div>`) + `</div>`;
    } else {
      const bits = [`Incumbent: ${pfull(r.party)}`];
      if (f.tl) bits.push(f.why === "term-limited" ? "term-limited" : "open seat (" + f.why + ")");
      inc = `<p class="sub" style="color:var(--ink);margin:0 0 6px">${bits.join(" · ")}</p>` +
        `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">${f.dsa ? `<span class="flag dsa">DSA-held</span>` : ""}${f.former ? `<span class="flag dsa">Formerly DSA-held</span>` : ""}${state.jur.showTgt && f.target ? `<span class="tgt">TARGET</span>` : ""}</div>`;
    }
    det.innerHTML = `<p class="eyebrow">District</p><h2 style="font-family:var(--font-ui)">${esc(T.name(sel))}</h2>
      <p class="sub">${T.year} election${type === "sb" && T.approx(sel) ? " · approximate boundary" : ""}${type === "dscc" ? " · two seats, Offices A and B" : ""}</p>
      ${inc}
      <p class="eyebrow" style="margin-top:4px">Members in this district</p>
      <div class="stats" style="grid-template-columns:repeat(4,1fr)">
        <div class="stat"><div class="v">${fmt(r.migs)}</div><div class="k">In good standing</div></div>
        <div class="stat"><div class="v">${fmt(r.all - r.migs)}</div><div class="k">Lapsed</div></div>
        <div class="stat"><div class="v">${fmt(r.all)}</div><div class="k">MIGS + Lapsed</div></div>
        <div class="stat"><div class="v">${fmt(r.int ?? 0)}</div><div class="k">Interested</div></div>
      </div>
      <p class="note">${r.all ? pctFmt(r.migs / r.all) + " of members here are in good standing. " : ""}${orl.length ? `${orl.length} Orleans Parish precinct${orl.length > 1 ? "s" : ""}.` : "Outside Orleans Parish."}${T.src && orl.length && orl.length < features.length ? " Member counts cover the whole district, including any part outside Orleans." : ""}${type === "dscc" ? " Member counts are for the House district, shared by both offices." : ""}</p>
      ${upOK ? `<button type="button" class="jbtn" id="jurOpen">See past results in this district</button>` : ""}`;
    const b = document.getElementById("jurOpen");
    if (b) b.addEventListener("click", () => {
      state.up.e = T.up; state.up.d = sel; saveUp();
      document.getElementById("upElection").value = state.up.e;
      showView("election"); setTab("up", true);
    });
  }

  // list
  const rows = all.filter(d => jPass(type, d)).sort((a, b) => (jVal(type, b) ?? -1) - (jVal(type, a) ?? -1));
  document.getElementById("jurListTitle").textContent = `${T.label} districts by ${m === "migs" ? "members in good standing" : m === "all" ? "MIGS + lapsed" : "interested contacts"}`;
  const box = document.getElementById("jurList");
  box.innerHTML = rows.length ? `<table class="jl"><thead><tr><th>District</th><th>MIGS</th><th>+ Lapsed</th><th>Int.</th></tr></thead><tbody>` +
    rows.map(d => { const r = jRec(type, d); return `<tr data-d="${d}" tabindex="0" class="${d === sel ? "sel" : ""}"><td>${esc(T.short(d))}<div class="tags">${jTags(type, d)}</div></td><td>${fmt(r.migs)}</td><td>${fmt(r.all)}</td><td>${fmt(r.int ?? 0)}</td></tr>`; }).join("") + `</tbody></table>`
    : `<p class="xnone">No districts match this filter.</p>`;
  box.querySelectorAll("tr[data-d]").forEach(tr => {
    const go = () => { state.jur.selected = tr.dataset.d; jrender(); jZoomTo(tr.dataset.d); };
    tr.addEventListener("click", go); tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
}
function jZoomTo(d) {
  const T = JT[state.jur.type];
  const fs = T.src ? [jShapes.get(T.src + d)].filter(Boolean) : (d.startsWith("AL") ? features : features.filter(f => (DIST[f.id] || {})[T.key] === d));
  if (!fs.length) return;
  const [[x0, y0], [x1, y1]] = jpath.bounds({ type: "FeatureCollection", features: fs }), [w, h] = jsize();
  const k = Math.max(0.15, Math.min(12, 0.75 / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  jsvg.transition().duration(600).call(jzoom.transform, d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}
function jDrawLegend(lo, med, hi) {
  const lg = d3.select("#jLegend");
  lg.selectAll("*").remove();
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "jlg");
  d3.range(0, 1.0001, 0.05).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", jscale(lo + t * (hi - lo))));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#jlg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, W]), g = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  [[lo, "start", fmt(Math.round(lo)) + " low"], [med, "middle", "median " + fmt(Math.round(med))], [hi, "end", "high " + fmt(Math.round(hi))]].forEach(([v, a, text]) => {
    const px = x(v);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    g.append("text").attr("x", a === "middle" ? Math.min(W - 70, Math.max(70, px)) : px).attr("y", 15).attr("text-anchor", a)
      .attr("fill", "currentColor").style("font", font).text(text);
  });
}
document.getElementById("jurType").addEventListener("change", e => { state.jur.type = e.target.value; state.jur.selected = null; saveJur(); jrender(); jFitView(true); });
[["jm-migs", "migs"], ["jm-all", "all"], ["jm-int", "int"]].forEach(([id, k]) => document.getElementById(id).addEventListener("click", () => { state.jur.measure = k; saveJur(); jrender(); }));
document.querySelectorAll("[data-jf]").forEach(b => b.addEventListener("click", () => { state.jur.filter = b.dataset.jf; jrender(); }));
document.getElementById("jTgtToggle").addEventListener("click", () => { state.jur.showTgt = !state.jur.showTgt; jrender(); });
document.querySelectorAll("[data-jv]").forEach(b => b.addEventListener("click", () => { state.jur.view = b.dataset.jv; jFitView(true); }));
let jrt;
new ResizeObserver(() => { if (currentView !== "membership" || state.jur.tab !== "jur") return; clearTimeout(jrt); jrt = setTimeout(() => { jlayout(); jrender(); jFitView(false); }, 120); }).observe(jsvg.node().parentNode);

function setMemTab(tab) {
  state.jur.tab = tab; saveJur();
  const z = tab === "zip";
  document.getElementById("mtab-zip").setAttribute("aria-selected", z); document.getElementById("mtab-zip").tabIndex = z ? 0 : -1;
  document.getElementById("mtab-jur").setAttribute("aria-selected", !z); document.getElementById("mtab-jur").tabIndex = z ? -1 : 0;
  document.getElementById("zipRail").hidden = !z; document.getElementById("jurRail").hidden = z;
  document.getElementById("zipControls").hidden = !z; document.getElementById("jurControls").hidden = z;
  document.getElementById("memMapwrap").hidden = !z; document.getElementById("jurMapwrap").hidden = z;
  if (currentView !== "membership") return;
  if (z) { mlayout(); mrender(); mFitView(false); }
  else { jlayout(); jrender(); jFitView(false); }
}
document.getElementById("mtab-zip").addEventListener("click", () => setMemTab("zip"));
document.getElementById("mtab-jur").addEventListener("click", () => setMemTab("jur"));
document.querySelectorAll("#view-membership .tabs").forEach(tb => tb.addEventListener("keydown", e => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const t = state.jur.tab === "zip" ? "jur" : "zip"; setMemTab(t); document.getElementById("mtab-" + t).focus(); }
}));

/* ================= Demographics ================= */
const DEMO = DATA.demo;
const DFIELDS = "id,pop,raceTot,nhWhite,nhBlack,hisp,nhAsian,hhTot,renter,burdTot,burd30,renterTot,renterBurd30,medInc,incTot,under50k,povTot,below100,below200,empTot,wage,selfEmp,lf,unemp,renterMOE".split(",");
const DSUM = DFIELDS.slice(1).filter(k => k !== "medInc" && k !== "renterMOE");
const DROWS = new Map(DEMO.rows.split(";").map(s => { const a = s.split(","), o = { id: a[0] }; DFIELDS.slice(1).forEach((k, i) => o[k] = +a[i + 1]); return [o.id, o]; }));
const PARISH = DROWS.get("P");                     // Orleans
const PCODE = { O: "Orleans", J: "Jefferson", B: "St. Bernard", T: "St. Tammany" };
const PSHORT = { O: "Orl.", J: "Jeff.", B: "St. B.", T: "St. T." };
const PROWS = { O: PARISH, J: DROWS.get("PJ"), B: DROWS.get("PB"), T: DROWS.get("PT") };
const fixRings = f => { f.geometry.coordinates.forEach(poly => poly.forEach(ring => { if (d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI) ring.reverse(); })); return f; };
const tractFeats = (DEMO.tracts + "\n" + (DEMO.mtracts || "")).split("\n").filter(Boolean).map(line => { const [t, body] = line.split("|"); return fixRings({ type: "Feature", id: t, geometry: { type: "MultiPolygon", coordinates: decodeRings(body) } }); });
const tractPar = t => t.includes(":") ? t[0] : "O";
const tractCode = t => t.includes(":") ? t.slice(2) : t;
const tractName = t => { const c = tractCode(t), n = +c.slice(0, 4), s = c.slice(4); return s === "00" ? String(n) : `${n}.${s}`; };
// tract -> share of its area in each council (c), school board (s) and congressional (g) district
const TSPLIT = new Map(DEMO.split.split(";").map(s => {
  const [t, rest] = s.split(":"), parts = rest.split("|"), o = {};
  ["c", "s", "g"].forEach((k, i) => {
    const ws = parts[i].split("/").map(x => x.split("=")), tot = d3.sum(ws, w => +w[1]);
    o[k] = ws.map(([d, v]) => [d, +v / tot]);
  });
  return [t, o];
}));

const pctOf = (a, b) => b > 0 ? a / b : null;
const DM = [
  { k: "index", grp: "Summary", label: "Working-class index", short: "Index", f: null, unit: "index", desc: "A constructed score, not a Census measure: the average percentile, compared with census tracts in the same parish, on renters, cost burden, households under $50k, people below 200% of poverty, wage workers and people of color. 50 is a typical tract for that parish; 90 means more working-class than 90% of the parish's tracts. ZIP codes and House districts are compared within the parish that holds most of them." },
  { k: "renter", grp: "Housing", label: "Renter households", short: "Renters", f: r => pctOf(r.renter, r.hhTot), desc: "Share of occupied homes that are rented." },
  { k: "burden", grp: "Housing", label: "Housing cost-burdened households", short: "Burdened", f: r => pctOf(r.burd30, r.burdTot), desc: "Households spending 30% or more of income on rent or owner costs." },
  { k: "rburden", grp: "Housing", label: "Cost-burdened renters", short: "Burd. rent", f: r => pctOf(r.renterBurd30, r.renterTot), desc: "Renter households spending 30% or more of income on rent." },
  { k: "under50", grp: "Income & work", label: "Households earning under $50,000", short: "<$50k", f: r => pctOf(r.under50k, r.incTot), desc: "Share of households with income under $50,000 a year." },
  { k: "medinc", grp: "Income & work", label: "Median household income", short: "Median inc.", f: r => r.medInc > 0 ? r.medInc : null, inv: true, money: true, direct: true, desc: "Lower incomes are shaded greener. Not available for estimated districts or where Census suppresses it." },
  { k: "pov100", grp: "Income & work", label: "Below the poverty line", short: "Poverty", f: r => pctOf(r.below100, r.povTot), desc: "People in households below the federal poverty line, which scales with household size." },
  { k: "pov200", grp: "Income & work", label: "Below 200% of the poverty line", short: "<200% pov.", f: r => pctOf(r.below200, r.povTot), desc: "People in households earning less than twice the poverty line for their size: near-poor and poor." },
  { k: "wage", grp: "Income & work", label: "Wage and salary workers", short: "Wage wkrs", f: r => pctOf(r.wage, r.empTot), desc: "Share of employed residents who work for an employer (private, nonprofit or government) rather than for themselves." },
  { k: "self", grp: "Income & work", label: "Self-employed and business owners", short: "Self-emp.", f: r => pctOf(r.selfEmp, r.empTot), inv: true, desc: "Share of employed residents who are self-employed or own a business. Lower shares are shaded greener." },
  { k: "unemp", grp: "Income & work", label: "Unemployment rate", short: "Unemp.", f: r => pctOf(r.unemp, r.lf), desc: "Unemployed people as a share of the civilian labor force (5-year average)." },
  { k: "nonwhite", grp: "Race", label: "People of color", short: "POC", f: r => pctOf(r.raceTot - r.nhWhite, r.raceTot), desc: "Everyone except non-Hispanic white residents." },
  { k: "black", grp: "Race", label: "Black residents", short: "Black", f: r => pctOf(r.nhBlack, r.raceTot), desc: "Non-Hispanic Black residents as a share of the population." },
  { k: "hisp", grp: "Race", label: "Hispanic or Latino residents", short: "Latino", f: r => pctOf(r.hisp, r.raceTot), desc: "Hispanic or Latino residents of any race." },
  { k: "regD", grp: "Voter registration", label: "Registered Democrats", short: "Dem.", f: r => pctOf(r.rD, r.rT), pos: "Greener = more Democrats", desc: "Share of registered voters who are Democrats (Secretary of State, Oct. 1, 2026)." },
  { k: "regR", grp: "Voter registration", label: "Registered Republicans", short: "Rep.", f: r => pctOf(r.rR, r.rT), inv: true, pos: "Greener = fewer Republicans", desc: "Share of registered voters who are Republicans. Lower shares are shaded greener." },
  { k: "regO", grp: "Voter registration", label: "No party or other party", short: "Other", f: r => pctOf(r.rO, r.rT), pos: "Greener = more independents and third parties", desc: "Registered voters with no party or a party other than Democrat or Republican." }
];
const DMK = new Map(DM.map(m => [m.k, m]));
const INDEX_PARTS = ["renter", "burden", "under50", "pov200", "wage", "nonwhite"];
const TABLE_COLS = ["renter", "pov200", "nonwhite"];
const SMALL_HH = 300;

// majority parish of a ZIP (from the precincts inside it) and of a House district; null when outside the four parishes
let zipParCache = null;
function zipPar(z) {
  if (!zipParCache) { zipParCache = {}; PSPLIT.forEach((o, p) => o.z.forEach(([zz, w]) => { const c = zipParCache[zz] || (zipParCache[zz] = {}); c[parCode(p)] = (c[parCode(p)] || 0) + w; })); }
  const c = zipParCache[z]; if (!c) return null;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}
function housePar(d) {
  const c = {}; Object.entries(DIST).forEach(([p, x]) => { if (x.h === d) c[parCode(p)] = (c[parCode(p)] || 0) + 1; });
  const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return e ? e[0] : null;
}
// voter registration (Democrat, Republican, other) by precinct, from the Secretary of State's parish report
const REGP = new Map((DATA.reg || "").split(";").filter(Boolean).map(s => { const a = s.split(","); return [a[0], a.slice(1).map(Number)]; }));
function regBy(geo) {
  const out = new Map(), add = (k, v, w) => { if (k == null) return; const o = out.get(k) || [0, 0, 0]; for (let i = 0; i < 3; i++) o[i] += v[i] * w; out.set(k, o); };
  REGP.forEach((v, p) => {
    if (p[0] === "P" && !p.includes("-") && !p.includes(":")) return;         // parish totals
    if (geo === "tract" || geo === "zip") {
      const sp = PSPLIT.get(p); if (!sp) return;
      const parts = geo === "tract" ? sp.t : sp.z, W = d3.sum(parts, x => x[1]) || 1;
      parts.forEach(([k, w]) => add(k, v, w / W));
    } else add((DIST[p] || {})[DG[geo].key || (geo === "house" ? "h" : "")], v, 1);
  });
  return out;
}
["O", "J", "B", "T"].forEach(c => { const v = REGP.get("P" + c) || [0, 0, 0], r = PROWS[c]; r.rD = v[0]; r.rR = v[1]; r.rO = v[2]; r.rT = v[0] + v[1] + v[2]; });
const METRO = (() => { const o = {}; DSUM.concat(["rD", "rR", "rO", "rT"]).forEach(k => o[k] = d3.sum(Object.values(PROWS), r => r[k])); o.medInc = 0; return o; })();
function aggRows(parts) {   // parts: [[row, weight]]
  const o = { medInc: 0 };
  DSUM.forEach(k => o[k] = d3.sum(parts, ([r, w]) => r[k] * w));
  return o;
}
const DG = {
  tract: { label: "Census tracts", unit: "tract", one: id => `Tract ${tractName(id)}, ${PCODE[tractPar(id)]}` },
  zip: { label: "ZIP codes", unit: "ZIP code", one: id => `ZIP ${id}` },
  house: { label: "State House districts", unit: "district", one: id => `House District ${id}` },
  council: { label: "City Council districts (estimated)", unit: "district", one: id => `Council District ${id}`, est: true, key: "c" },
  sb: { label: "School Board districts (estimated)", unit: "district", one: id => `School Board District ${id}`, est: true, key: "s" },
  cong: { label: "Congress, Orleans Parish portion (estimated)", unit: "district", one: id => `LA-0${id} (Orleans part)`, est: true, key: "g" }
};
const dUnitCache = {};
function dUnits(geo) {
  if (dUnitCache[geo]) return dUnitCache[geo];
  let u = [];
  if (geo === "tract") u = tractFeats.filter(f => !/^99/.test(tractCode(f.id))).map(f => ({ id: f.id, row: DROWS.get("T" + f.id), feats: [f], orleans: tractPar(f.id) === "O", par: tractPar(f.id) })).filter(x => x.row);
  else if (geo === "zip") u = zfeat.map(f => ({ id: f.id, row: DROWS.get("Z" + f.id), feats: [f] })).filter(x => x.row).map(x => ({ ...x, orleans: x.id.startsWith("701") }));
  else if (geo === "house") u = [...DROWS.keys()].filter(k => k[0] === "H").map(k => { const d = String(+k.slice(1)); return { id: d, row: DROWS.get(k), feats: [jShapes.get("H" + d)].filter(Boolean), orleans: features.some(p => (DIST[p.id] || {}).h === d) }; }).filter(x => x.feats.length);
  else {
    const key = DG[geo].key, parts = new Map();
    TSPLIT.forEach((o, t) => { const r = DROWS.get("T" + t); if (!r) return; o[key].forEach(([d, w]) => { if (!parts.has(d)) parts.set(d, []); parts.get(d).push([r, w]); }); });
    u = [...parts].sort((a, b) => a[0].localeCompare(b[0])).map(([d, ps]) => ({ id: d, row: aggRows(ps), feats: features.filter(p => (DIST[p.id] || {})[key] === d), pr: true, orleans: true, ntr: ps.length }));
  }
  u.forEach(x => { x.name = DG[geo].one(x.id); x.small = x.row.hhTot < SMALL_HH; });
  const rg = regBy(geo); u.forEach(x => { const v = rg.get(x.id) || [0, 0, 0]; x.row.rD = v[0]; x.row.rR = v[1]; x.row.rO = v[2]; x.row.rT = v[0] + v[1] + v[2]; });
  // which parish each area is compared within: its own for tracts, the parish holding most of it for ZIPs and House districts, Orleans for Orleans-only districts
  u.forEach(x => { if (!x.par) x.par = geo === "zip" ? zipPar(x.id) : geo === "house" ? housePar(x.id) : "O"; });
  // working-class index: average percentile on each part, measured against the census tracts of the same parish
  u.filter(x => !x.small).forEach(x => {
    const ps = INDEX_PARTS.map(k => { const v = DMK.get(k).f(x.row); return v == null ? null : tractPct(k, v, x.par); }).filter(v => v != null);
    x.index = ps.length === INDEX_PARTS.length ? d3.mean(ps) : null;
  });
  return (dUnitCache[geo] = u);
}
const tractRef = {};
function tractPct(k, v, par) {
  const key = k + "|" + (par || "all");
  if (!tractRef[key]) tractRef[key] = tractFeats.filter(f => !par || tractPar(f.id) === par).map(f => DROWS.get("T" + f.id)).filter(r => r && r.hhTot >= SMALL_HH).map(DMK.get(k).f).filter(x => x != null).sort(d3.ascending);
  const a = tractRef[key]; if (a.length < 2) return 50;
  return (d3.bisectLeft(a, v) + d3.bisectRight(a, v)) / 2 / a.length * 100;
}
const dVal = (x, k) => k === "index" ? (x.index ?? null) : DMK.get(k).f(x.row);
const dFmt = (v, k) => v == null ? "–" : k === "index" ? v.toFixed(0) : DMK.get(k).money ? "$" + fmt(Math.round(v)) : (v * 100).toFixed(1) + "%";

state.demo = { geo: "tract", m: "index", view: "nola", selected: null, sort: null, asc: false, parish: "all" };
try { const s = JSON.parse(localStorage.getItem("nola-demo-v1") || "{}"); if (DG[s.geo]) state.demo.geo = s.geo; if (DMK.has(s.m)) state.demo.m = s.m; } catch (e) {}
const saveDemo = () => { try { localStorage.setItem("nola-demo-v1", JSON.stringify({ geo: state.demo.geo, m: state.demo.m, parish: state.demo.parish })); } catch (e) {} };
try { const s = JSON.parse(localStorage.getItem("nola-demo-v1") || "{}"); if (s.parish && (s.parish === "all" || PCODE[s.parish])) state.demo.parish = s.parish; } catch (e) {}
// the areas currently shown: tracts can be narrowed to one parish
const dShown = geo => { const u = dUnits(geo); return geo === "tract" && state.demo.parish !== "all" ? u.filter(x => x.par === state.demo.parish) : u; };
// benchmark for the detail bars and table: the chosen parish, Orleans for Orleans-only districts, otherwise the metro
const dBench = geo => geo === "tract" && state.demo.parish !== "all" ? { row: PROWS[state.demo.parish], name: PCODE[state.demo.parish] + " Parish" }
  : DG[geo].est ? { row: PARISH, name: "Orleans Parish" } : { row: METRO, name: "Metro (four parishes)" };

(function fillMeasures() {
  const sel = document.getElementById("demoMeasure");
  let html = "", g = null;
  DM.forEach(m => { if (m.grp !== g) { if (g) html += "</optgroup>"; html += `<optgroup label="${esc(m.grp)}">`; g = m.grp; } html += `<option value="${m.k}">${esc(m.label)}</option>`; });
  sel.innerHTML = html + "</optgroup>";
})();

const dsvg = d3.select("#dmap"), droot = dsvg.append("g");
const gD = droot.append("g"), gDU = droot.append("g"), gDO = droot.append("g"), gDS = droot.append("g"), gDL = droot.append("g");
const dproj = d3.geoMercator(), dpath = d3.geoPath(dproj);
let dscale;
function dsize() { return boxSize(dsvg.node().parentNode); }
function dlayout() {
  const [w, h] = dsize();
  dproj.fitExtent([[20, 70], [w - 20, h - 20]], { type: "FeatureCollection", features });
}
// labels shrink with the zoom so they stay the same size on screen, and hide until their area is wide enough to hold them
const dLabSize = () => state.demo.geo === "tract" ? 10.5 : state.demo.geo === "zip" ? 11.5 : 13;
function dSizeLabels(k) {
  const fs = dLabSize();
  gDL.selectAll("text").style("font-size", fs / k + "px").style("stroke-width", 3 / k + "px")
    .style("display", d => d.always || (d.w * k >= d.t.length * fs * 0.62 + 4 && d.h * k >= fs + 2) ? null : "none");
}
const dzoom = d3.zoom().scaleExtent([0.15, 40]).on("zoom", ev => { droot.attr("transform", ev.transform); dSizeLabels(ev.transform.k); });
dsvg.call(dzoom);
document.getElementById("dzin").onclick = () => dsvg.transition().duration(250).call(dzoom.scaleBy, 1.6);
document.getElementById("dzout").onclick = () => dsvg.transition().duration(250).call(dzoom.scaleBy, 1 / 1.6);
function dFitFeatures(fs, animate, pad) {
  const [w, h] = dsize();
  const [[x0, y0], [x1, y1]] = dpath.bounds({ type: "FeatureCollection", features: fs });
  const k = Math.max(0.15, Math.min(40, (pad || 0.92) / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  const tr = d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  (animate ? dsvg.transition().duration(500) : dsvg).call(dzoom.transform, tr);
}
function dFitView(animate) {
  const u = dShown(state.demo.geo);
  const fs = state.demo.view === "nola" ? features : u.flatMap(x => x.feats);
  dFitFeatures(fs, animate);
  document.querySelectorAll("[data-dv]").forEach(b => b.setAttribute("aria-pressed", b.dataset.dv === state.demo.view));
}
document.getElementById("dzfit").onclick = () => dFitView(true);
document.querySelectorAll("[data-dv]").forEach(b => b.addEventListener("click", () => { state.demo.view = b.dataset.dv; dFitView(true); }));
function dZoomTo(x) { if (x && x.feats.length) dFitFeatures(x.feats, true, 0.55); }

function dShowTip(ev, x) {
  const k = state.demo.m, tip = document.getElementById("dtip");
  tip.innerHTML = `<b>${esc(x.name)}</b> · ${esc(DMK.get(k).short)} <b>${dFmt(dVal(x, k), k)}</b> · ${fmt(Math.round(x.row.hhTot))} households` + (x.small ? " · small sample" : "");
  const box = dsvg.node().getBoundingClientRect();
  let px = ev.clientX - box.left + 14, py = ev.clientY - box.top + 14;
  tip.hidden = false;
  if (px + tip.offsetWidth > box.width - 8) px = ev.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = px + "px"; tip.style.top = py + "px";
}

function drender() {
  const { geo, m } = state.demo, M = DMK.get(m), G = DG[geo], u = dShown(geo), B = dBench(geo);
  document.getElementById("demoParishCtl").hidden = geo !== "tract";
  document.getElementById("demoParishSel").value = state.demo.parish;
  document.getElementById("demoGeo").value = geo;
  document.getElementById("demoMeasure").value = m;
  const avail = !(M.direct && G.est);
  const vals = u.filter(x => !x.small).map(x => dVal(x, m)).filter(v => v != null).sort(d3.ascending);
  let lo = vals[0] ?? 0, hi = vals[vals.length - 1] ?? 1, med = d3.median(vals) ?? 0;
  if (hi <= lo) hi = lo + 1; if (med <= lo || med >= hi) med = (lo + hi) / 2;
  const ryg = rygColors();
  dscale = d3.scaleLinear().domain([lo, med, hi]).range(M.inv ? ryg.slice().reverse() : ryg).interpolate(d3.interpolateRgb).clamp(true);
  const items = u.flatMap(x => x.feats.map(f => ({ key: geo + ":" + x.id + ":" + f.id, f, x })));
  gD.selectAll("path").data(items, it => it.key).join("path")
    .attr("class", it => "dunit" + (it.x.pr ? " pr" : ""))
    .attr("d", it => dpath(it.f))
    .attr("fill", it => { const v = dVal(it.x, m); return v == null ? "var(--empty)" : dscale(v); })
    .style("stroke", it => it.x.pr ? (dVal(it.x, m) == null ? null : dscale(dVal(it.x, m))) : null)
    .attr("fill-opacity", it => it.x.small ? 0.45 : 1)
    .on("mousemove", dShowTip).on("mouseleave", () => document.getElementById("dtip").hidden = true)
    .on("click", (ev, it) => { state.demo.selected = state.demo.selected === it.x.id ? null : it.x.id; drender(); });
  // selection: precinct-built districts get a thick ring drawn under a fresh copy of their fills, which hides the inner precinct edges
  const selU = u.find(x => x.id === state.demo.selected);
  const fillOf = x => { const v = dVal(x, m); return v == null ? "var(--empty)" : dscale(v); };
  gDU.selectAll("path").data(selU && selU.pr ? selU.feats : []).join("path").attr("class", "selunder").attr("d", dpath);
  gDO.selectAll("path").data(selU && selU.pr ? selU.feats : []).join("path").attr("class", "dunit pr").attr("d", dpath)
    .attr("fill", selU && selU.pr ? fillOf(selU) : null).style("stroke", selU && selU.pr ? fillOf(selU) : null).style("pointer-events", "none");
  gDS.selectAll("path").data(selU && !selU.pr ? selU.feats : []).join("path").attr("class", "selring").attr("d", dpath);
  // labels for districts
  const kz = d3.zoomTransform(dsvg.node()).k;
  const labText = x => geo === "tract" ? tractName(x.id) : geo === "cong" ? "LA-0" + x.id : x.id;   // tract numbers repeat only across parishes, which the map already separates
  const labs = u.map(x => {
    let sx = 0, sy = 0, sa = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    x.feats.forEach(f => {
      const a = dpath.area(f), c = dpath.centroid(f), b = dpath.bounds(f);
      if (Number.isFinite(a) && Number.isFinite(c[0])) { sx += c[0] * a; sy += c[1] * a; sa += a; }
      if (Number.isFinite(b[0][0])) { x0 = Math.min(x0, b[0][0]); y0 = Math.min(y0, b[0][1]); x1 = Math.max(x1, b[1][0]); y1 = Math.max(y1, b[1][1]); }
    });
    // narrow shapes: use the smaller of bounding-box width and the width a square of the same area would have
    const w = Math.min(x1 - x0, Math.sqrt(sa) * 1.3), h = Math.min(y1 - y0, Math.sqrt(sa) * 1.3);
    return sa ? { id: geo + ":" + x.id, x: sx / sa, y: sy / sa, t: labText(x), w, h, always: !!G.est } : null;
  }).filter(Boolean);
  gDL.selectAll("text").data(labs, d => d.id).join("text").attr("class", "zlabel dlab").attr("text-anchor", "middle")
    .attr("x", d => d.x).attr("y", d => d.y).attr("dy", "0.35em").text(d => d.t);
  dSizeLabels(kz);
  dDrawLegend(lo, med, hi, M);
  document.getElementById("dmT").textContent = M.label;
  document.getElementById("dmS").textContent = `by ${G.label.replace(" (estimated)", "")}` + (G.est ? " · estimated from census tracts" : "") + (!avail ? " · not available for estimated districts" : "");
  document.getElementById("dLegTitle").textContent = m === "index" ? "Working-class index (percentile within parish)" : M.label;
  document.getElementById("dLegPos").textContent = M.pos || "Greener = more working-class";

  // parish comparison
  const P = B.row;
  const pk = [["renter", "Renters"], ["pov200", "<200% pov."], ["nonwhite", "POC"], ["medinc", "Median inc."], ["regD", "Dem."]];
  const cur = geo === "tract" ? state.demo.parish : G.est ? "O" : "all";
  document.getElementById("demoParish").innerHTML = `<table class="mt dt"><thead><tr><th>Parish</th>${pk.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead><tbody>` +
    [["O"], ["J"], ["B"], ["T"], ["all"]].map(([c]) => { const r = c === "all" ? METRO : PROWS[c]; return `<tr data-par="${c}" tabindex="0" class="${c === cur ? "sel" : ""}${c === "all" ? " parish" : ""}"><td>${c === "all" ? "Metro" : PCODE[c]}</td>${pk.map(([k]) => `<td>${dFmt(DMK.get(k).f(r), k)}</td>`).join("")}</tr>`; }).join("") + `</tbody></table>`;
  document.querySelectorAll("#demoParish tr[data-par]").forEach(tr => { const go = () => { state.demo.geo = "tract"; state.demo.parish = tr.dataset.par; state.demo.selected = null; state.demo.sort = null; saveDemo(); drender(); dFitView(true); }; tr.addEventListener("click", go); tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); }); });

  // detail
  const det = document.getElementById("demoDetail");
  if (!selU) det.innerHTML = `<p class="eyebrow">${esc(G.unit[0].toUpperCase() + G.unit.slice(1))}</p><p class="sub" style="margin:0">Click an area on the map or in the table for its full profile.</p><p class="note">${esc(M.desc)}</p>`;
  else {
    const r = selU.row, rankable = u.filter(x => !x.small && dVal(x, m) != null && (!selU.par || x.par === selU.par));
    const v = dVal(selU, m), rank = v == null || selU.small ? null : 1 + rankable.filter(x => M.inv ? dVal(x, m) < v : dVal(x, m) > v).length;
    const bar = (k, label) => {
      const MM = DMK.get(k), val = MM.f(r), pv = MM.f(P);
      if (val == null) return `<span class="k">${label}</span><span class="v">–</span><span class="b"></span>`;
      const scale = MM.money ? 200000 : 1;
      return `<span class="k">${label}</span><span class="v">${dFmt(val, k)}</span><span class="b" title="${esc(B.name)}: ${dFmt(pv, k)}"><i style="width:${Math.min(100, val / scale * 100)}%"></i><s style="left:${Math.min(100, pv / scale * 100)}%"></s></span>`;
    };
    const ctx = geo === "tract" ? (() => { const o = TSPLIT.get(selU.id); if (!o) return PCODE[tractPar(selU.id)] + " Parish"; const ds = (k, f) => o[k].filter(([, w]) => w >= 0.1).map(([d]) => f(d)).join(", "); return `Council ${ds("c", d => d)} · School Board ${ds("s", d => d)} · LA-0${ds("g", d => d)}`; })() : "";
    det.innerHTML = `<p class="eyebrow">${esc(G.unit[0].toUpperCase() + G.unit.slice(1))}</p><h2 style="font-family:var(--font-ui)">${esc(selU.name)}</h2>
      <p class="sub">${fmt(Math.round(r.pop))} residents · ${fmt(Math.round(r.hhTot))} households${ctx ? " · " + ctx : ""}${selU.ntr ? ` · built from ${selU.ntr} tracts` : ""}</p>
      ${selU.small ? `<p class="note" style="margin:0 0 8px">Fewer than ${SMALL_HH} households: estimates here are unreliable and this area is left out of rankings.</p>` : ""}
      ${selU.index != null ? `<div class="stats" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px"><div class="stat"><div class="v">${selU.index.toFixed(0)}</div><div class="k">Working-class index</div></div><div class="stat"><div class="v">${rank ? ordinal(rank) : "–"}</div><div class="k">of ${rankable.length}${selU.par && (geo !== "tract" || state.demo.parish === "all") ? " in " + PCODE[selU.par] : ""} on ${esc(M.short.toLowerCase())}${M.inv ? " (lowest first)" : ""}</div></div></div>` : ""}
      <p class="dgrp">Housing</p><div class="dbar">${bar("renter", "Renter households")}${bar("burden", "Cost-burdened households")}${bar("rburden", "Cost-burdened renters")}</div>
      <p class="dgrp">Income &amp; work</p><div class="dbar">${bar("medinc", "Median household income")}${bar("under50", "Households under $50k")}${bar("pov100", "Below poverty")}${bar("pov200", "Below 200% of poverty")}${bar("wage", "Wage and salary workers")}${bar("self", "Self-employed")}${bar("unemp", "Unemployment rate")}</div>
      <p class="dgrp">Race</p><div class="dbar">${bar("nonwhite", "People of color")}${bar("black", "Black")}${bar("hisp", "Hispanic or Latino")}</div>
      <p class="dgrp">Voter registration${r.rT ? ` · ${fmt(Math.round(r.rT))} registered` : ""}</p><div class="dbar">${bar("regD", "Democrats")}${bar("regR", "Republicans")}${bar("regO", "No party or other")}</div>
      <p class="note">The dark tick on each bar marks ${esc(B.name)}${B.row === METRO ? " (no combined median income)" : ""}. Median income bars run from $0 to $200,000.${G.est ? " Median income isn't available for estimated districts." : ""}</p>`;
  }

  // table
  const sk = state.demo.sort || m, sM = DMK.get(sk), asc = state.demo.sort ? state.demo.asc : !!sM.inv;
  const cols = [m, ...TABLE_COLS.filter(k => k !== m)].slice(0, 4);
  const rows = u.slice().sort((a, b) => {
    if (a.small !== b.small) return a.small ? 1 : -1;
    const va = dVal(a, sk), vb = dVal(b, sk);
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return asc ? va - vb : vb - va;
  });
  document.getElementById("demoListTitle").textContent = `${u.length} ${G.label.replace(" (estimated)", "").replace("Congress, Orleans Parish portion", "districts")}${geo === "tract" && state.demo.parish !== "all" ? " in " + PCODE[state.demo.parish] : ""}`;
  const th = k => `<th class="${k === sk ? "on" : ""}" ${k === sk ? `aria-sort="${asc ? "ascending" : "descending"}"` : ""}><button type="button" data-sort="${k}" title="${esc(DMK.get(k).label)}">${esc(DMK.get(k).short)}</button></th>`;
  const box = document.getElementById("demoList");
  box.innerHTML = `<table class="mt dt tt"><thead><tr><th class="l">${esc(G.unit[0].toUpperCase() + G.unit.slice(1))}</th>${cols.map(th).join("")}</tr></thead><tbody>
    <tr class="parish"><td title="${esc(B.name)}">${esc(B.row === METRO ? "Metro" : B.name.replace(" Parish", ""))}</td>${cols.map(k => `<td class="${k === m ? "on" : ""}">${k === "index" ? "–" : dFmt(DMK.get(k).f(P), k)}</td>`).join("")}</tr>` +
    rows.map(x => `<tr data-d="${esc(x.id)}" tabindex="0" class="${x.id === state.demo.selected ? "sel" : ""}${x.small ? " small" : ""}"><td title="${esc(x.name)}">${esc(geo === "tract" ? (state.demo.parish === "all" ? PSHORT[x.par] + " " : "") + tractName(x.id) : geo === "cong" ? "LA-0" + x.id : x.id)}${x.small ? " •" : ""}</td>${cols.map(k => `<td class="${k === m ? "on" : ""}">${dFmt(dVal(x, k), k)}</td>`).join("")}</tr>`).join("") + `</tbody></table>`;
  box.querySelectorAll("tr[data-d]").forEach(tr => {
    const go = () => { state.demo.selected = tr.dataset.d; drender(); dZoomTo(u.find(x => x.id === tr.dataset.d)); };
    tr.addEventListener("click", go); tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
  box.querySelectorAll("button[data-sort]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.sort;
    if (state.demo.sort === k) state.demo.asc = !state.demo.asc; else { state.demo.sort = k; state.demo.asc = !!DMK.get(k).inv; }
    drender();
  }));
  document.getElementById("demoCsvBox").hidden = true;
}
function dDrawLegend(lo, med, hi, M) {
  const lg = d3.select("#dLegend");
  lg.selectAll("*").remove();
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "dlg");
  d3.range(0, 1.0001, 0.05).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", dscale(lo + t * (hi - lo))));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#dlg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, W]), g = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  const f = v => M.k === "index" ? v.toFixed(0) : M.money ? "$" + Math.round(v / 1000) + "k" : (v * 100).toFixed(0) + "%";
  [[lo, "start", f(lo) + " low"], [med, "middle", "median " + f(med)], [hi, "end", "high " + f(hi)]].forEach(([v, a, text]) => {
    const px = x(v);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    g.append("text").attr("x", a === "middle" ? Math.min(W - 100, Math.max(100, px)) : px).attr("y", 15).attr("text-anchor", a)
      .attr("fill", "currentColor").style("font", font).text(text);
  });
}
document.getElementById("demoGeo").addEventListener("change", e => { state.demo.geo = e.target.value; state.demo.selected = null; state.demo.sort = null; saveDemo(); drender(); dFitView(true); });
document.getElementById("demoParishSel").addEventListener("change", e => { state.demo.parish = e.target.value; state.demo.selected = null; state.demo.sort = null; saveDemo(); drender(); dFitView(true); });
document.getElementById("demoMeasure").addEventListener("change", e => { state.demo.m = e.target.value; state.demo.sort = null; saveDemo(); drender(); });
document.getElementById("demoCsv").addEventListener("click", () => {
  const { geo } = state.demo, u = dShown(geo), ks = DM.map(m => m.k);
  const q = s => /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const raw = (x, k) => { const v = dVal(x, k); return v == null ? "" : k === "index" ? v.toFixed(1) : DMK.get(k).money ? Math.round(v) : (v * 100).toFixed(1); };
  const csv = [["area", "residents", "households", "small_sample", ...DM.map(m => m.k === "index" ? "wc_index" : m.money ? m.k + "_usd" : m.k + "_pct")].join(",")]
    .concat(["O", "J", "B", "T"].map(c => [q(PCODE[c] + " Parish"), PROWS[c].pop, PROWS[c].hhTot, "", ...ks.map(k => raw({ row: PROWS[c] }, k))].join(",")))
    .concat(u.map(x => [q(x.name), Math.round(x.row.pop), Math.round(x.row.hhTot), x.small ? "yes" : "", ...ks.map(k => raw(x, k))].join(","))).join("\n");
  const box = document.getElementById("demoCsvBox");
  box.value = csv; box.hidden = false; box.select();
  const b = document.getElementById("demoCsv");
  const done = ok => { b.textContent = ok ? "Copied" : "Select and copy below"; setTimeout(() => b.textContent = "Copy CSV", 1800); };
  try { navigator.clipboard.writeText(csv).then(() => done(true), () => done(false)); } catch (e) { done(false); }
});
let drt;
new ResizeObserver(() => { if (currentView !== "demographics") return; clearTimeout(drt); drt = setTimeout(() => { dlayout(); drender(); dFitView(false); }, 120); }).observe(dsvg.node().parentNode);
function showDemographics() { dlayout(); drender(); dFitView(false); }

/* ================= Summary ================= */
const PSPLIT = new Map((DATA.psplit + (DATA.mpsplit ? ";" + DATA.mpsplit : "")).split(";").map(s => {
  const m = s.match(/^([JBT]:[^:]+|[^:]+):(.*)$/), p = m[1], [a, b] = m[2].split("|");   // suburban ids carry a parish prefix ("J:001")
  const pr = x => x ? x.split("/").map(y => { const [k, v] = y.split("="); return [k, +v]; }) : [];
  return [p, { t: pr(a), z: pr(b) }];
}));
const pctRank = (sorted, v) => sorted.length ? (d3.bisectLeft(sorted, v) + d3.bisectRight(sorted, v)) / 2 / sorted.length * 100 : 50;
const wmean = pairs => { let s = 0, w = 0; pairs.forEach(([v, x]) => { if (v != null) { s += v * x; w += x; } }); return w ? s / w : null; };
const zRate = z => { const c = MEM.counts[z], f = zById.get(z); return f && f.properties.pop > 0 ? (c ? c[0] : 0) / f.properties.pop * 1e4 : null; };
const ordPct = v => v == null ? "–" : Math.round(v);

const sumCache = {};
// scope: "mix" = working class and vote within parish, members across all four (the default);
// "parish" = all three within parish; "all" = all three across the four parishes. weighted: DSCC race-type weights
function sumPrecincts(g, scope = "mix", weighted = false) {
  const ck = g + "|" + scope + "|" + (weighted ? 1 : 0);
  if (sumCache[ck]) return sumCache[ck];
  const tIdx = new Map(dUnits("tract").map(x => [x.id, x.index]));
  const td = new Map(trendData(weighted).map(r => [r.p, r]));
  const rows = allFeatures.map(f => {
    const s = PSPLIT.get(f.id) || { t: [], z: [] }, tr = td.get(f.id);
    return {
      p: f.id, f, dist: DIST[f.id] || {},
      wcRaw: wmean(s.t.map(([t, w]) => [tIdx.get(t) ?? null, w])),
      supRaw: tr && tr[g] ? tr[g].score : null, nRaces: tr && tr[g] ? tr[g].n : 0,
      memRaw: wmean(s.z.map(([z, w]) => [zRate(z), w])), zips: s.z.filter(([, w]) => w >= 0.2).map(([z]) => z)
    };
  });
  // percentiles are taken within each parish: Orleans precincts against Orleans precincts, Jefferson against Jefferson, and so on
  const ref = {};
  rows.forEach(r => r.par = parCode(r.p));
  ["wc", "sup", "mem"].forEach(k => {
    ref[k] = {};
    ["O", "J", "B", "T"].forEach(c => ref[k][c] = rows.filter(r => r.par === c).map(r => r[k + "Raw"]).filter(v => v != null).sort(d3.ascending));
    ref[k].all = rows.map(r => r[k + "Raw"]).filter(v => v != null).sort(d3.ascending);
    // membership is ranked across all four parishes, so a handful of suburban members isn't inflated
    const within = scope === "parish" || (scope === "mix" && k !== "mem");
    rows.forEach(r => r[k] = r[k + "Raw"] == null ? null : pctRank(within ? ref[k][r.par] : ref[k].all, r[k + "Raw"]));
  });
  return (sumCache[ck] = { rows, ref, byP: new Map(rows.map(r => [r.p, r])) });
}

const SR = {
  house: { jt: "house", key: "h", geo: "house" }, dscc: { jt: "dscc", key: "h", geo: "house" },
  sb: { jt: "sb", key: "s", geo: "sb" }, cong: { jt: "cong", key: "g", geo: "cong" }, council: { jt: "council", key: "c", geo: "council" }
};
const distSort = (a, b) => isNaN(a) || isNaN(b) ? a.localeCompare(b) : a - b;
function sumDistricts(e, g) {
  const S = SR[e], P = sumPrecincts(g, "mix", e === "dscc" && dsccWeighted);
  const ds = [...new Set(P.rows.map(r => r.dist[S.key]).filter(Boolean))].sort(distSort);
  const gu = new Map(dUnits(S.geo).map(x => [x.id, x]));
  return ds.map(d => {
    const ps = P.rows.filter(r => r.dist[S.key] === d);
    const avg = k => { const xs = ps.filter(r => r[k] != null); return xs.length ? d3.mean(xs, r => r[k]) : null; };
    const rec = JUR[S.jt] && JUR[S.jt][d], unit = gu.get(d);
    let mem, memRate, memSrc;
    const pop = S.geo === "cong" ? null : unit ? unit.row.pop : null;
    if (rec && pop) { memRate = rec.migs / pop * 1e4; mem = pctRank(P.ref.mem.all, memRate); memSrc = "district"; }
    else { mem = avg("mem"); memRate = avg("memRaw"); memSrc = "zip"; }
    const wc = avg("wc"), sup = avg("sup");
    const score = [wc, sup, mem].every(v => v != null) ? (wc + sup + mem) / 3 : null;
    return { d, ps, wc, sup, mem, memRate, memSrc, migs: rec ? rec.migs : null, score, rec, flags: rec ? jFlags(S.jt, d) : {},
      wcIdx: unit ? unit.index : null, supPts: avg("supRaw"), pop: unit ? unit.row.pop : null, outside: S.geo === "house" || S.geo === "cong" };
  });
}

// intervention categories
const CATS = {
  E: { label: "More events", color: "var(--c-e)", hex: "#e07a2e", desc: "High working class, low DSA vote, few members. People who should be with us aren't voting with us yet and we have little presence: hold events, canvass, show up." },
  R: { label: "More recruitment", color: "var(--c-r)", hex: "#2f73d1", desc: "High working class and strong DSA vote, but few members. Supporters are here; ask them to join." },
  I: { label: "Social inquiry", color: "var(--c-i)", hex: "#8e55c4", desc: "High working class and many members, but low DSA vote. We're here and the neighborhood should be with us, yet it isn't voting with us: find out why." }
};
const WC_HIGH = 55;   // working class counts as high from the 55th percentile; vote and members use the top third (67)
function catsOf(r, cut) {
  if ([r.wc, r.sup, r.mem].some(v => v == null)) return [];
  const hi = v => cut === "thirds" ? v >= 200 / 3 : v > 50, lo = v => cut === "thirds" ? v <= 100 / 3 : v < 50;
  const out = [];
  if (!(r.wc >= WC_HIGH)) return out;                         // only working-class precincts are targets (a lower bar than other scores)
  if (lo(r.sup) && lo(r.mem)) out.push("E");                  // not voting with us, few members: show up
  if (hi(r.sup) && lo(r.mem)) out.push("R");                  // voting with us, few members: ask them to join
  if (lo(r.sup) && hi(r.mem)) out.push("I");                  // members here, but neighbors don't vote with us: find out why
  return out;
}
// how strongly a precinct fits a type: the average of the scores that should be high minus the average of those that should be low
const catStrength = (r, c) => c === "E" ? r.wc - (r.sup + r.mem) / 2 : c === "R" ? (r.wc + r.sup) / 2 - r.mem : (r.wc + r.mem) / 2 - r.sup;
const catFill = cs => !cs.length ? null : CATS[cs[0]].color;
const ctype = c => `<span class="ctype" style="background:${CATS[c].color}">${esc(CATS[c].label)}</span>`;

state.sum = { tab: "run", e: "house", color: "score", g: "dsa", tgt: false, sel: null, af: "all", cut: "thirds", group: "c", pSel: null };
try { const s = JSON.parse(localStorage.getItem("nola-sum-v1") || "{}"); ["tab", "e", "color", "g", "group"].forEach(k => { if (s[k]) state.sum[k] = s[k]; }); if (!SR[state.sum.e]) state.sum.e = "house"; } catch (e) {}
const saveSum = () => { try { const { tab, e, color, g, cut, group } = state.sum; localStorage.setItem("nola-sum-v1", JSON.stringify({ tab, e, color, g, cut, group })); } catch (e) {} };

const ssvg = d3.select("#smap"), sroot = ssvg.append("g");
const gS = sroot.append("g"), gSU = sroot.append("g"), gSO = sroot.append("g"), gSS = sroot.append("g"), gSL = sroot.append("g");
const sproj = d3.geoMercator(), spath = d3.geoPath(sproj);
let sscale;
function ssize() { return boxSize(ssvg.node().parentNode); }
function slayout() { const [w, h] = ssize(); sproj.fitExtent([[20, 70], [w - 20, h - 20]], { type: "FeatureCollection", features }); }
const szoom = d3.zoom().scaleExtent([0.1, 40]).on("zoom", ev => {
  sroot.attr("transform", ev.transform);
  gSL.selectAll("text").style("font-size", 13 / ev.transform.k + "px").style("stroke-width", 3 / ev.transform.k + "px");
});
ssvg.call(szoom);
document.getElementById("szin").onclick = () => ssvg.transition().duration(250).call(szoom.scaleBy, 1.6);
document.getElementById("szout").onclick = () => ssvg.transition().duration(250).call(szoom.scaleBy, 1 / 1.6);
function sFit(fs, animate, pad) {
  const [w, h] = ssize();
  const [[x0, y0], [x1, y1]] = spath.bounds({ type: "FeatureCollection", features: fs });
  const k = Math.max(0.1, Math.min(40, (pad || 0.92) / Math.max((x1 - x0) / w, (y1 - y0) / (h - 70))));
  (animate ? ssvg.transition().duration(500) : ssvg).call(szoom.transform, d3.zoomIdentity.translate(w / 2, (h + 60) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}
const sumExtent = () => state.sum.tab === "act" || ["house", "dscc", "cong"].includes(state.sum.e) ? allFeatures : features;
document.getElementById("szfit").onclick = () => sFit(sumExtent(), true);
function sTip(ev, html) {
  const tip = document.getElementById("stip"); tip.innerHTML = html;
  const box = ssvg.node().getBoundingClientRect();
  let x = ev.clientX - box.left + 14, y = ev.clientY - box.top + 14;
  tip.hidden = false;
  if (x + tip.offsetWidth > box.width - 8) x = ev.clientX - box.left - tip.offsetWidth - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideSTip = () => document.getElementById("stip").hidden = true;
const scoreBg = v => v == null ? "var(--empty)" : d3.scaleLinear().domain([0, 50, 100]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true)(v);
const trio = x => `<span class="trio" title="Working class · DSA vote · Membership (working class and vote: percentiles within the parish; membership: across all four parishes)"><i style="background:${scoreBg(x.wc)}">${ordPct(x.wc)}</i><i style="background:${scoreBg(x.sup)}">${ordPct(x.sup)}</i><i style="background:${scoreBg(x.mem)}">${ordPct(x.mem)}</i></span>`;
function fbar(label, v, extra) {
  return `<div class="fbar"><span>${label}</span><span class="v">${v == null ? "–" : ordinal(Math.round(v)) + " pct."}</span><span class="b"><i style="width:${v ?? 0}%;background:${scoreBg(v)}"></i><s></s></span>${extra ? `<span class="x">${extra}</span>` : ""}</div>`;
}
function sLegendRamp(lo, med, hi, f) {
  const lg = d3.select("#sLegend"); lg.selectAll("*").remove(); lg.style("display", null);
  const W = legW(lg), grad = lg.append("defs").append("linearGradient").attr("id", "slg");
  d3.range(0, 1.0001, 0.05).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", sscale(lo + t * (hi - lo))));
  lg.append("rect").attr("x", 0).attr("y", 4).attr("width", W).attr("height", 14).attr("fill", "url(#slg)").attr("rx", 2);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, W]), g = lg.append("g").attr("transform", "translate(0,22)");
  const font = "500 11px " + getComputedStyle(document.documentElement).getPropertyValue("--font-data");
  [[lo, "start", f(lo) + " low"], [med, "middle", "median " + f(med)], [hi, "end", "high " + f(hi)]].forEach(([v, a, text]) => {
    const px = x(v);
    g.append("line").attr("x1", px).attr("x2", px).attr("y1", -4).attr("y2", 2).attr("stroke", "currentColor").attr("opacity", .5);
    g.append("text").attr("x", a === "middle" ? Math.min(W - 100, Math.max(100, px)) : px).attr("y", 15).attr("text-anchor", a).attr("fill", "currentColor").style("font", font).text(text);
  });
}
const sumName = (e, d) => JT[SR[e].jt].name(d);
const sumShort = (e, d) => e === "cong" ? `LA-0${d}` : e === "council" ? `District ${d}` : e === "sb" ? `District ${d}` : `HD ${d}`;

/* ---- Where to run ---- */
function runWhy(x) {
  const parts = [];
  const lvl = v => v >= 70 ? "strong" : v >= 55 ? "above-average" : v >= 45 ? "average" : v >= 30 ? "below-average" : "weak";
  parts.push(`${lvl(x.wc)} working class (${ordPct(x.wc)})`, `${lvl(x.sup)} DSA vote (${ordPct(x.sup)})`, `${lvl(x.mem)} membership (${ordPct(x.mem)})`);
  return parts.join(", ");
}
function runTags(e, x) {
  let h = "";
  if (e === "dscc") { if (x.rec) Object.entries(x.rec.offices).forEach(([o, v]) => { if (v.dsa === "Y") h += `<span class="flag dsa">Office ${o} · DSA</span>`; if (state.sum.tgt && v.target) h += `<span class="tgt">${o} TARGET</span>`; }); return h; }
  if (x.flags.dsa) h += `<span class="flag dsa">DSA-held</span>`;
  if (x.flags.former) h += `<span class="flag dsa">Former DSA</span>`;
  if (x.flags.tl) h += `<span class="flag">Open seat (${x.flags.why || "term-limited"})</span>`;
  if (x.rec && x.rec.party === "R") h += `<span class="flag">Republican incumbent</span>`;
  if (state.sum.tgt && x.flags.target) h += `<span class="tgt">TARGET</span>`;
  return h;
}
function renderRun() {
  const { e, color, g } = state.sum, xs = sumDistricts(e, g), T = JT[SR[e].jt];
  document.getElementById("runElection").value = e;
  document.getElementById("runColor").value = color;
  document.querySelectorAll("[data-sg]").forEach(b => b.setAttribute("aria-pressed", b.dataset.sg === g));
  document.getElementById("runTgt").setAttribute("aria-pressed", state.sum.tgt);
  const val = x => x[color];
  const vals = xs.map(val).filter(v => v != null).sort(d3.ascending);
  let lo = vals[0] ?? 0, hi = vals[vals.length - 1] ?? 100, med = d3.median(vals) ?? 50;
  if (hi <= lo) hi = lo + 1; if (med <= lo || med >= hi) med = (lo + hi) / 2;
  sscale = d3.scaleLinear().domain([lo, med, hi]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true);
  const byD = new Map(xs.map(x => [x.d, x])), key = SR[e].key;
  const fillP = r => { const x = byD.get(r.dist[key]); return x && val(x) != null ? sscale(val(x)) : "var(--empty)"; };
  const P = sumPrecincts(g, "mix", e === "dscc" && dsccWeighted);
  document.getElementById("runWeightRow").hidden = e !== "dscc";
  document.querySelectorAll("[data-rdw]").forEach(b => b.setAttribute("aria-pressed", (b.dataset.rdw === "1") === dsccWeighted));
  gS.selectAll("path").data(P.rows, d => (d.r || d).p).join("path").attr("class", "sp fill").attr("d", r => spath(r.f))
    .attr("fill", fillP).style("stroke", fillP)
    .on("mousemove", (ev, r) => { const x = byD.get(r.dist[key]); if (!x) return; sTip(ev, `<b>${esc(sumName(e, x.d))}</b> · run score <b>${ordPct(x.score)}</b> · working class ${ordPct(x.wc)} · DSA vote ${ordPct(x.sup)} · members ${ordPct(x.mem)}`); })
    .on("mouseleave", hideSTip)
    .on("click", (ev, r) => { const d = r.dist[key]; state.sum.sel = state.sum.sel === d ? null : d; renderRun(); });
  const sel = xs.find(x => x.d === state.sum.sel), selPs = sel ? sel.ps : [];
  gSU.selectAll("path").data(selPs, r => r.p).join("path").attr("class", "selunder").attr("d", r => spath(r.f));
  gSO.selectAll("path").data(selPs, r => r.p).join("path").attr("class", "sp fill").attr("d", r => spath(r.f)).attr("fill", fillP).style("stroke", fillP).style("pointer-events", "none");
  gSS.selectAll("path").remove();
  const k = d3.zoomTransform(ssvg.node()).k;
  const labs = xs.map(x => { let sx = 0, sy = 0, sa = 0; x.ps.forEach(r => { const a = spath.area(r.f), c = spath.centroid(r.f); if (Number.isFinite(a) && Number.isFinite(c[0])) { sx += c[0] * a; sy += c[1] * a; sa += a; } }); return sa ? { id: x.d, x: sx / sa, y: sy / sa, t: e === "cong" ? "LA-0" + x.d : x.d } : null; }).filter(Boolean);
  gSL.selectAll("text").data(labs, l => l.id).join("text").attr("class", "zlabel dlab").attr("text-anchor", "middle").attr("dy", "0.35em")
    .attr("x", l => l.x).attr("y", l => l.y).style("font-size", 13 / k + "px").style("stroke-width", 3 / k + "px").text(l => l.t);
  const cl = { score: "Run score", wc: "Working class", sup: "DSA vote", mem: "Membership" }[color];
  document.getElementById("smT").textContent = `${T.year} ${T.label}: ${cl.toLowerCase()}`;
  document.getElementById("smS").textContent = (["house", "dscc", "cong"].includes(e) ? "Orleans, Jefferson, St. Bernard and St. Tammany precincts" : "Orleans Parish") + ` · working class and vote ranked within each parish, membership across all four` + (e === "council" ? " · at-large seats are parish-wide" : "");
  document.getElementById("sLegTitle").textContent = `${cl} by district (percentile)`;
  sLegendRamp(lo, med, hi, v => Math.round(v));
  document.getElementById("sLegNote").innerHTML = `<span class="swatch" style="background:var(--div-pos)"></span><span>Better place to run</span>`;

  // recommendations
  const ranked = xs.filter(x => x.score != null).sort((a, b) => b.score - a.score);
  const notDSA = ranked.filter(x => !(e === "dscc" ? x.rec && Object.values(x.rec.offices).every(o => o.dsa === "Y") : x.flags.dsa));
  const top = notDSA.slice(0, 6);
  document.getElementById("runRecTitle").textContent = `Best ${T.year} ${T.label} districts to run in`;
  document.getElementById("runRecs").innerHTML = (top.length ? top.map((x, i) => `<div class="rec" data-d="${esc(x.d)}" tabindex="0" role="button">
      <span class="n">${i + 1}</span><span class="h">${esc(sumName(e, x.d))}</span><span class="s">${ordPct(x.score)}</span>
      <span class="w">${esc(runWhy(x))}</span><span class="tags">${runTags(e, x)}</span></div>`).join("") : `<p class="xnone">No districts to rank.</p>`) +
    `<p class="note">Districts are ranked by the average of the three percentiles; seats DSA already holds are left out of this list${e === "dscc" ? " when both offices are DSA-held" : ""}.${e === "dscc" && dsccWeighted ? " DSA vote is weighted for this Democratic party race: all-Democrat races count fully, mixed fields half, D v R races and measures a quarter." : ""}${e === "council" ? " The two at-large seats are parish-wide, so their scores are the parish average (50) by definition." : ""}</p>`;
  document.querySelectorAll("#runRecs .rec").forEach(el => { const go = () => { state.sum.sel = el.dataset.d; renderRun(); sFit(byD.get(el.dataset.d).ps.map(r => r.f), true, 0.6); }; el.addEventListener("click", go); el.addEventListener("keydown", ev => { if (ev.key === "Enter") go(); }); });

  // detail
  const det = document.getElementById("runDetail");
  if (!sel) det.innerHTML = `<p class="eyebrow">District</p><p class="sub" style="margin:0">Click a district on the map or in the table for its three scores.</p>`;
  else {
    const cats = { E: 0, R: 0, I: 0 };
    sel.ps.forEach(r => catsOf(r, state.sum.cut).forEach(c => cats[c]++));
    const memX = sel.memSrc === "district" ? `${fmt(sel.migs)} members in good standing in the district · ${sel.memRate.toFixed(1)} per 10k residents` : `About ${sel.memRate == null ? "–" : sel.memRate.toFixed(1)} members per 10k residents, from the ZIP codes its precincts sit in`;
    det.innerHTML = `<p class="eyebrow">District</p><h2 style="font-family:var(--font-ui)">${esc(sumName(e, sel.d))}</h2>
      <p class="sub">${T.year} election · run score <b style="color:var(--ink)">${ordPct(sel.score)}</b> · ${sel.ps.length} precincts in ${listAnd([...new Set(sel.ps.map(r => parishOf(r.p)))])}${e === "cong" ? " (the district also covers other parishes)" : ""}</p>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">${runTags(e, sel)}</div>
      ${fbar("Working class", sel.wc, sel.wcIdx != null ? `Demographics working-class index for the district: ${sel.wcIdx.toFixed(0)}` : "")}
      ${fbar("DSA vote", sel.sup, sel.supPts != null ? `${g === "dsa" ? "DSA" : "DSA + recommended"} candidates ran ${pts(sel.supPts)} pts versus their citywide averages, on average across these precincts` : "")}
      ${fbar("Membership", sel.mem, memX)}
      <p class="advice">${esc(runWhy(sel))[0].toUpperCase() + esc(runWhy(sel)).slice(1)}.${cats.E + cats.R + cats.I ? ` Inside it: ${[["E", "need more events"], ["R", "need more recruitment"], ["I", "need social inquiry"]].filter(([c]) => cats[c]).map(([c, t]) => `${cats[c]} precinct${cats[c] > 1 ? "s" : ""} ${t}`).join(", ")} (see Where to intervene).` : ""}</p>
      <button type="button" class="jbtn" id="runOpen" style="margin-top:10px">See past results in this district</button>`;
    document.getElementById("runOpen").addEventListener("click", () => {
      state.up.e = JT[SR[e].jt].up; state.up.d = sel.d; saveUp();
      document.getElementById("upElection").value = state.up.e;
      showView("election"); setTab("up", true);
    });
  }

  // table
  const rs = state.sum.rs || (state.sum.rs = { k: "score", dir: -1 });
  const rv = x => rs.k === "d" ? x.d : x[rs.k];
  const rows = xs.slice().sort((a, b) => { const va = rv(a), vb = rv(b);
    if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return rs.k === "d" ? rs.dir * distSort(va, vb) : rs.dir * (va - vb) || (b.score ?? -1) - (a.score ?? -1); });
  const sb = (k, label, tip) => `<button type="button" class="tfs${rs.k === k ? " on" + (rs.dir > 0 ? " asc" : "") : ""}" data-rk="${k}"${tip ? ` title="${tip}"` : ""}>${label}</button>`;
  const al = e === "council" ? Object.keys(JUR.council).filter(d => d.startsWith("AL")) : [];
  document.getElementById("runListTitle").textContent = `${xs.length} ${T.label} districts`;
  const box = document.getElementById("runList");
  box.innerHTML = `<table class="jl tf"><thead><tr><th>${sb("d", "District")}</th><th><span class="tfsg">${sb("wc", "WC", "Working class")} · ${sb("sup", "Vote", "DSA vote")} · ${sb("mem", "Mem.", "Membership")}</span></th><th>${sb("score", "Score", "Run score")}</th></tr></thead><tbody>` +
    rows.map(x => `<tr data-d="${esc(x.d)}" tabindex="0" class="${x.d === state.sum.sel ? "sel" : ""}"><td>${esc(sumShort(e, x.d))}<div class="tags">${runTags(e, x)}</div></td><td>${trio(x)}</td><td><b>${ordPct(x.score)}</b></td></tr>`).join("") +
    al.map(d => `<tr><td>${esc(JT.council.short(d))}<div class="tags">${runTags(e, { flags: jFlags("council", d), rec: JUR.council[d] })}</div></td><td colspan="2" style="text-align:left;color:var(--muted);font-family:var(--font-ui)">Parish-wide</td></tr>`).join("") + `</tbody></table>`;
  box.querySelectorAll("tr[data-d]").forEach(tr => { const go = () => { state.sum.sel = tr.dataset.d; renderRun(); sFit(byD.get(tr.dataset.d).ps.map(r => r.f), true, 0.6); }; tr.addEventListener("click", go); tr.addEventListener("keydown", ev => { if (ev.key === "Enter") go(); }); });
  box.querySelectorAll("button[data-rk]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.rk; if (rs.k === k) rs.dir = -rs.dir; else { rs.k = k; rs.dir = k === "d" ? 1 : -1; }
    renderRun();
  }));
  document.getElementById("runListTitle").textContent = `${xs.length} ${T.label} districts · ${{ score: "by run score", d: "by district", wc: "by working class", sup: "by DSA vote", mem: "by membership" }[rs.k]}`;
  document.getElementById("runCsvBox").hidden = true;
}
document.getElementById("runCsv").addEventListener("click", () => {
  const { e, g } = state.sum, xs = sumDistricts(e, g).slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const r1 = v => v == null ? "" : v.toFixed(1);
  const csv = ["district,run_score,working_class_pct,dsa_vote_pct,membership_pct,wc_index,dsa_vote_pts,members_migs,members_per_10k,orleans_precincts,dsa_held,open_seat"]
    .concat(xs.map(x => [`"${sumName(e, x.d)}"`, r1(x.score), r1(x.wc), r1(x.sup), r1(x.mem), r1(x.wcIdx), x.supPts == null ? "" : (x.supPts * 100).toFixed(1), x.memSrc === "district" ? x.migs : "", r1(x.memRate), x.ps.length, x.flags.dsa ? "yes" : "", x.flags.tl ? "yes" : ""].join(","))).join("\n");
  const box = document.getElementById("runCsvBox"); box.value = csv; box.hidden = false; box.select();
  const b = document.getElementById("runCsv"), done = ok => { b.textContent = ok ? "Copied" : "Select and copy below"; setTimeout(() => b.textContent = "Copy CSV", 1800); };
  try { navigator.clipboard.writeText(csv).then(() => done(true), () => done(false)); } catch (err) { done(false); }
});

/* ---- Where to intervene ---- */
// ---- intervene: colors, scatter selection and table filters
const AC_LABEL = { wc: "Working class", sup: "DSA vote", mem: "Membership", gE: "Events gap", gR: "Recruitment gap", gI: "Inquiry gap" };
const acVal = (r, k) => k[0] === "g" ? ([r.wc, r.sup, r.mem].some(v => v == null) ? null : catStrength(r, k[1])) : r[k];
state.sum.cm = "type"; state.sum.brush = null; state.sum.sx = "wc"; state.sum.sy = "sup";
state.sum.tf = { q: "", wc: "any", sup: "any", mem: "any", loc: "", sk: "gap", dir: -1 };
const tfPass = (v, f) => f === "any" || (v != null && (f === "h67" ? v >= 200 / 3 : f === "h50" ? v >= 50 : f === "l50" ? v < 50 : v <= 100 / 3));
const locOf = r => r.dist.c ? "Council " + r.dist.c : isMetro(r.p) ? parishOf(r.p) : "–";

function renderAct() {
  const { g, cut, af, cm, tf } = state.sum, P = sumPrecincts(g);
  // flags always use the default ranks; a score colour can switch every value to "within parish" or "across all four"
  const V = cm === "type" ? P : sumPrecincts(g, state.sum.ps || "all");
  document.getElementById("actScopeCtl").hidden = cm === "type";
  document.querySelectorAll("[data-ps]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ps === (state.sum.ps || "all")));
  document.querySelectorAll("[data-sg]").forEach(b => b.setAttribute("aria-pressed", b.dataset.sg === g));
  document.querySelectorAll("[data-af]").forEach(b => b.setAttribute("aria-pressed", b.dataset.af === af));
  document.getElementById("actColor").value = cm;
  const rows = P.rows.map(r => ({ r: V.byP.get(r.p), cs: catsOf(r, cut) }));
  const shown = x => af === "any" ? true : af === "all" ? x.cs.length > 0 : x.cs.includes(af);
  const tfOK = x => (!tf.q || pName(x.r.p).toLowerCase().includes(tf.q.toLowerCase())) && tfPass(x.r.wc, tf.wc) && tfPass(x.r.sup, tf.sup) && tfPass(x.r.mem, tf.mem) && (!tf.loc || locOf(x.r) === tf.loc);
  const brushed = x => !state.sum.brush || state.sum.brush.has(x.r.p);
  const visible = x => shown(x) && tfOK(x) && brushed(x);
  // colour: intervention type, or a red–green scale for one score or gap
  let fillOf;
  if (cm === "type") fillOf = x => x.cs.length ? catFill(x.cs) : "var(--empty)";
  else {
    const vals = rows.filter(shown).map(x => acVal(x.r, cm)).filter(v => v != null);
    const isGap = cm[0] === "g", mx = isGap ? Math.max(10, Math.ceil((d3.max(vals, Math.abs) || 10) / 10) * 10) : 100;
    sscale = d3.scaleLinear().domain(isGap ? [-mx, 0, mx] : [0, 50, 100]).range(rygColors()).interpolate(d3.interpolateRgb).clamp(true);
    fillOf = x => { const v = acVal(x.r, cm); return v == null ? "var(--empty)" : sscale(v); };
  }
  const onMap = x => (cm !== "type" && af === "all") || shown(x);        // a score colours the whole map under "All types"
  const fillShown = x => onMap(x) ? fillOf(x) : "var(--empty)";
  const matches = x => tfOK(x) && brushed(x);
  gS.selectAll("path").data(rows, d => (d.r || d).p).join("path").attr("d", x => spath(x.r.f))
    .attr("class", x => "sp" + (onMap(x) && !matches(x) ? " fade" : "")).attr("fill", fillShown).style("stroke", null)
    .on("mousemove", (ev, x) => sTip(ev, `${esc(pLabel(x.r.p))} · working class ${ordPct(x.r.wc)} · DSA vote ${ordPct(x.r.sup)} · members ${ordPct(x.r.mem)}` + (cm[0] === "g" && acVal(x.r, cm) != null ? ` · ${AC_LABEL[cm].toLowerCase()} ${acVal(x.r, cm) >= 0 ? "+" : "−"}${Math.abs(Math.round(acVal(x.r, cm)))}` : "") + (x.cs.length ? ` · ${x.cs.map(c => CATS[c].label.toLowerCase()).join(" + ")}` : "")))
    .on("mouseleave", hideSTip)
    .on("click", (ev, x) => { state.sum.pSel = state.sum.pSel === x.r.p ? null : x.r.p; renderAct(); });
  gSU.selectAll("path").remove(); gSO.selectAll("path").remove(); gSL.selectAll("text").remove();
  const selR = state.sum.pSel ? V.byP.get(state.sum.pSel) : null;
  gSS.selectAll("path").data(selR ? [selR] : []).join("path").attr("class", "selring").attr("d", r => spath(r.f));
  const filtering = !!state.sum.brush || tf.q || tf.loc || tf.wc !== "any" || tf.sup !== "any" || tf.mem !== "any";
  document.getElementById("smT").textContent = (af === "all" ? (cm === "type" ? "Where DSA should intervene" : "Every precinct") : af === "any" ? "Every precinct" : CATS[af].label) + (cm !== "type" ? ` · colored by ${AC_LABEL[cm].toLowerCase()}` : "");
  document.getElementById("smS").textContent = (cm === "type" ? `Working class and vote ranked within parish, membership across all four · working class high = 55+, vote and members high = 67+, low = 33 or less` : `Scores ranked ${(state.sum.ps || "all") === "all" ? "across all four parishes" : "within each parish"}`) + (filtering ? " · faded precincts are outside your chart selection" : "");
  if (cm === "type") {
    document.getElementById("sLegTitle").textContent = "Intervention type";
    d3.select("#sLegend").style("display", "none");
    document.getElementById("sLegNote").innerHTML = `<span class="lgrid">` + Object.entries(CATS).map(([c, v]) => `<span><span class="swatch" style="background:${v.color}"></span>${esc(v.label)}</span>`).join("") +
      `<span><span class="swatch"></span>No flag</span></span>`;
  } else {
    const [lo, mid, hi] = sscale.domain();
    document.getElementById("sLegTitle").textContent = cm[0] === "g" ? `${AC_LABEL[cm]} (percentile points)` : `${AC_LABEL[cm]} (percentile)`;
    sLegendRamp(lo, mid, hi, v => (cm[0] === "g" && v > 0 ? "+" : "") + Math.round(v));
    const lab = { wc: "More working-class", sup: "Stronger DSA vote", mem: "More members", gE: "Bigger events gap", gR: "Bigger recruitment gap", gI: "Bigger inquiry gap" }[cm];
    document.getElementById("sLegNote").innerHTML = `<span class="swatch" style="background:var(--div-pos)"></span><span>${lab}</span>`;
  }

  // category cards
  const cnt = c => rows.filter(x => x.cs.includes(c)).length;
  document.getElementById("actCats").innerHTML = Object.entries(CATS).map(([c, v]) => `<button type="button" class="acat" data-ac="${c}" aria-pressed="${af === c}">
      <span class="cdot" style="background:${v.color}"></span><b>${esc(v.label)}</b><span class="c">${cnt(c)}</span><span class="d">${esc(v.desc)}</span></button>`).join("") +
    `<p class="note">Every type requires a working-class score of 55 or more, so precincts that aren't working-class are never targeted. For DSA vote and membership, high means the top third (67 or more) and low the bottom third (33 or less).</p>`;
  document.querySelectorAll("#actCats .acat").forEach(b => b.addEventListener("click", () => { state.sum.af = state.sum.af === b.dataset.ac ? "all" : b.dataset.ac; renderAct(); }));

  drawScatter(rows, fillOf);

  // detail
  const det = document.getElementById("actDetail");
  if (!selR) det.innerHTML = `<p class="eyebrow">Precinct</p><p class="sub" style="margin:0">Click a precinct on the map or in the list for its scores and what to do there.</p>`;
  else {
    const cs = catsOf(P.byP.get(selR.p), cut), D = selR.dist;
    det.innerHTML = `<p class="eyebrow">Precinct</p><h2 style="font-family:var(--font-ui)">${esc(pLabel(selR.p))}</h2>
      <p class="sub">${[isMetro(selR.p) && parishOf(selR.p) + " Parish", D.h && `House ${D.h}`, D.c && `Council ${D.c}`, D.s && `School Board ${D.s}`, D.g && `LA-0${D.g}`].filter(Boolean).join(" · ")}${selR.zips.length ? ` · ZIP ${selR.zips.join(", ")}` : ""}</p>
      <div style="margin-bottom:8px">${cs.map(ctype).join("") || `<span class="sub">No intervention flag</span>`}</div>
      ${fbar("Working class", selR.wc, selR.wcRaw != null ? `Working-class index of its census tracts: ${selR.wcRaw.toFixed(0)}` : "No tract data")}
      ${fbar("DSA vote", selR.sup, selR.supRaw != null ? `${pts(selR.supRaw)} pts versus candidates' citywide averages, across ${selR.nRaces} race${selR.nRaces === 1 ? "" : "s"}` : "No DSA race results here")}
      ${fbar("Membership", selR.mem, selR.memRaw != null ? `${selR.memRaw.toFixed(1)} members in good standing per 10k residents in its ZIP code${selR.zips.length > 1 ? "s" : ""}` : "")}
      ${cs.map(c => `<p class="advice"><b>${esc(CATS[c].label)}.</b> ${esc(CATS[c].desc)}</p>`).join("")}
      ${precinctProfile(selR)}`;
    det.querySelectorAll("[data-up-e]").forEach(b => b.addEventListener("click", () => {
      state.up.e = b.dataset.upE; state.up.d = b.dataset.upD; saveUp(); state.selected = selR.p;
      document.getElementById("upElection").value = state.up.e; showView("election"); setTab("up", true);
    }));
    det.querySelectorAll("[data-cand]").forEach(b => b.addEventListener("click", () => {
      state.cand = +b.dataset.cand; state.compare = null; save(); state.selected = selR.p; showView("election"); setTab("prev", true, true); renderDetail();
    }));
  }

  // clusters by district
  const gk = state.sum.group;
  document.getElementById("actGroup").value = gk;
  const gval = r => gk === "p" ? parishOf(r.p) : r.dist[gk];
  const groups = d3.groups(rows.filter(x => gval(x.r)), x => gval(x.r)).map(([d, xs]) => ({ d, n: xs.length, E: xs.filter(x => x.cs.includes("E")).length, R: xs.filter(x => x.cs.includes("R")).length, I: xs.filter(x => x.cs.includes("I")).length }));
  const sk = af === "all" || af === "any" ? (x => x.E + x.R + x.I) : (x => x[af]);
  groups.sort((a, b) => sk(b) - sk(a) || distSort(a.d, b.d));
  const cbox = document.getElementById("actClusters");
  cbox.innerHTML = `<table class="jl"><thead><tr><th>District</th><th title="More events"><span class="cdot" style="background:var(--c-e)"></span>Events</th><th title="More recruitment"><span class="cdot" style="background:var(--c-r)"></span>Recruit</th><th title="Social inquiry"><span class="cdot" style="background:var(--c-i)"></span>Inquiry</th><th>Pct.</th></tr></thead><tbody>` +
    groups.map(x => `<tr data-g="${esc(x.d)}" tabindex="0"><td>${esc(gk === "h" ? "HD " + x.d : gk === "p" ? x.d : "District " + x.d)}</td><td>${x.E || "·"}</td><td>${x.R || "·"}</td><td>${x.I || "·"}</td><td style="color:var(--muted)">${x.n}</td></tr>`).join("") + `</tbody></table>`;
  cbox.querySelectorAll("tr[data-g]").forEach(tr => { const go = () => sFit(rows.filter(x => gval(x.r) === tr.dataset.g).map(x => x.r.f), true, 0.7); tr.addEventListener("click", go); tr.addEventListener("keydown", ev => { if (ev.key === "Enter") go(); }); });

  renderActTable(rows, visible);
}

// scatter: one dot per precinct; drag a box to select precincts
const scSvg = d3.select("#scatter"), scG = scSvg.append("g"), scAx = scG.append("g").attr("class", "ax"), scDots = scG.append("g"), scBrushG = scG.append("g");
let scBrushing = false;
function drawScatter(rows, fillOf) {
  const W = scSvg.node().getBoundingClientRect().width || 330, H = 270, m = { l: 30, r: 8, t: 8, b: 26 };
  scSvg.attr("viewBox", `0 0 ${W} ${H}`);
  const { sx, sy } = state.sum;
  document.getElementById("scX").value = sx; document.getElementById("scY").value = sy;
  const x = d3.scaleLinear().domain([0, 100]).range([m.l, W - m.r]), y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
  scAx.selectAll("*").remove();
  scAx.append("g").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([0, 33, 50, 67, 100]).tickSize(3));
  scAx.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues([0, 33, 50, 67, 100]).tickSize(3));
  scAx.append("line").attr("class", "mid").attr("x1", x(50)).attr("x2", x(50)).attr("y1", y(0)).attr("y2", y(100));
  scAx.append("line").attr("class", "mid").attr("x1", x(0)).attr("x2", x(100)).attr("y1", y(50)).attr("y2", y(50));
  scAx.append("text").attr("x", W - m.r - 4).attr("y", H - m.b - 5).attr("text-anchor", "end").text(AC_LABEL[sx] + " →");
  scAx.append("text").attr("x", m.l + 5).attr("y", m.t + 10).text("↑ " + AC_LABEL[sy]);
  const sizeK = sx !== "mem" && sy !== "mem";
  const pts = rows.filter(r => r.r[sx] != null && r.r[sy] != null);
  scDots.selectAll("circle").data(pts, d => d.r.p).join("circle")
    .attr("cx", d => x(d.r[sx])).attr("cy", d => y(d.r[sy]))
    .attr("r", d => sizeK && d.r.mem != null ? 1.6 + d.r.mem / 100 * 3.4 : 2.8)
    .attr("fill", fillOf).attr("class", d => (state.sum.brush && !state.sum.brush.has(d.r.p) ? "fade" : "") + (d.r.p === state.sum.pSel ? " on" : ""))
    .on("mousemove", (ev, d) => { const tip = document.getElementById("stip"); sTip(ev, `${esc(pLabel(d.r.p))} · ${AC_LABEL[sx].toLowerCase()} ${ordPct(d.r[sx])} · ${AC_LABEL[sy].toLowerCase()} ${ordPct(d.r[sy])}`); })
    .on("mouseleave", hideSTip)
    .on("click", (ev, d) => { state.sum.pSel = d.r.p; renderAct(); sFit([d.r.f], true, 0.25); });
  scDots.selectAll("circle.on").raise();
  document.getElementById("scNote").textContent = (sizeK ? "Dot size shows membership. " : "") + (state.sum.brush ? `${state.sum.brush.size} precincts selected. Drag a new box to change it.` : "Every precinct is shown here. Drag a box to select precincts; the map and table follow your selection.");
  document.getElementById("scClear").hidden = !state.sum.brush;
  const brush = d3.brush().extent([[m.l, m.t], [W - m.r, H - m.b]]);
  brush.on("end", ev => {
    if (scBrushing) return;
    if (!ev.selection) { if (ev.sourceEvent) { state.sum.brush = null; state.sum.brushBox = null; renderAct(); } return; }
    const [[x0, y0], [x1, y1]] = ev.selection;
    state.sum.brushBox = [x.invert(x0), y.invert(y0), x.invert(x1), y.invert(y1)];
    state.sum.brush = new Set(pts.filter(d => { const px = x(d.r[sx]), py = y(d.r[sy]); return px >= x0 && px <= x1 && py >= y0 && py <= y1; }).map(d => d.r.p));
    renderAct();
  });
  scBrushG.call(brush);
  scBrushing = true;
  const bb = state.sum.brushBox;
  scBrushG.call(brush.move, bb ? [[x(bb[0]), y(bb[1])], [x(bb[2]), y(bb[3])]] : null);
  scBrushing = false;
}

// everything we know about one precinct: demographics of its tracts, members in its ZIPs, every listed race, and what it votes on next
function precinctProfile(r) {
  const sp = PSPLIT.get(r.p) || { t: [], z: [] };
  // demographics: overlapping tracts, weighted by the share of the precinct each covers
  const parts = sp.t.map(([id, w]) => [DROWS.get("T" + id), w]).filter(([row]) => row && row.pop > 0);
  let demo = "";
  if (parts.length) {
    const tw = d3.sum(parts, p => p[1]), agg = aggRows(parts.map(([row, w]) => [row, w / tw]));
    const med = d3.sum(parts.filter(([row]) => row.medInc > 0), ([row, w]) => row.medInc * w) / (d3.sum(parts.filter(([row]) => row.medInc > 0), p => p[1]) || 1);
    const line = (k, label) => { const v = DMK.get(k).f(agg); return `<tr><td>${label}</td><td>${dFmt(v, k)}</td></tr>`; };
    demo = `<details class="pd" open><summary>Who lives here</summary>
      <table><tbody>${line("renter", "Renter households")}${line("burden", "Cost-burdened households")}${line("rburden", "Cost-burdened renters")}
      <tr><td>Median household income</td><td>${med ? "≈ $" + fmt(Math.round(med)) : "–"}</td></tr>${line("under50", "Households under $50k")}${line("pov100", "Below poverty")}${line("pov200", "Below 200% of poverty")}
      ${line("wage", "Wage and salary workers")}${line("self", "Self-employed")}${line("unemp", "Unemployment rate")}${line("nonwhite", "People of color")}${line("black", "Black")}${line("hisp", "Hispanic or Latino")}</tbody></table>
      <p class="note">Estimated from census tract${parts.length > 1 ? "s" : ""} ${parts.map(([, w], i) => tractName(sp.t[i][0]) + (parts.length > 1 ? ` (${Math.round(w / tw * 100)}%)` : "")).join(", ")}, weighted by how much of the precinct each covers. Median income is a weighted average of tract medians.</p></details>`;
  }
  // membership by ZIP
  const zs = sp.z.filter(([, w]) => w >= 0.05);
  const memb = zs.length ? `<details class="pd" open><summary>Members nearby</summary><table><thead><tr><th>ZIP</th><th>MIGS</th><th>+ Lapsed</th><th>Per 10k</th></tr></thead><tbody>` +
    zs.map(([z, w]) => { const c = MEM.counts[z] || [0, 0], f = zById.get(z), pop = f ? f.properties.pop : 0;
      return `<tr><td>${esc(z)}${zs.length > 1 ? ` <small>(${Math.round(w * 100)}%)</small>` : ""}</td><td>${c[0]}</td><td>${c[1]}</td><td>${pop ? (c[0] / pop * 1e4).toFixed(1) : "–"}</td></tr>`; }).join("") +
    `</tbody></table><p class="note">Members are only known by ZIP code; the precinct takes its ZIP's rate.</p></details>` : "";
  // every listed candidate who was on the ballot here
  const gs = gapsAt(r.p, "all").map(x => ({ ...x, ...candInfo(x.i) })).sort((a, b) => d3.descending(a.race.date, b.race.date));
  const last = gs.length ? precinctStats(gs[0].race, gs[0].idx, r.p) : null;
  const votes = `<details class="pd" open><summary>How it voted</summary>` +
    `<p class="sub" style="margin:0 0 6px">${REG[r.p] ? fmt(REG[r.p]) + " registered voters" : "Registered voters not reported"}${last && last.reg ? ` · ${pctFmt(last.voted / last.reg)} turnout in ${last ? gs[0].race.date.slice(0, 4) : ""} (${esc(gs[0].race.title)})` : ""}</p>` +
    (gs.length ? `<table><thead><tr><th>Candidate</th><th>Share</th><th title="Share here minus the candidate's average across all their precincts">vs avg</th></tr></thead><tbody>` +
      gs.map(x => `<tr><td><button type="button" class="pdlink" data-cand="${x.i}" title="Open in Previous elections">${x.star ? STAR() : ""}${esc(CANDIDATES[x.i].label)}</button><small>${esc(x.race.title)} · ${x.race.date.slice(0, 4)}</small></td><td>${pctFmt(x.share)}</td><td class="${x.gap >= 0 ? "pos" : "neg"}">${pts(x.gap)}</td></tr>`).join("") + `</tbody></table>`
      : `<p class="xnone">No listed candidate has been on the ballot here.</p>`) + `</details>`;
  // what it votes on next, with the incumbent from the races sheet
  const D = r.dist, nxt = [["house", "h", 2027], ["dscc", "h", 2028], ["sb", "s", 2028], ["cong", "g", 2028], ["council", "c", 2029]].filter(([, k]) => D[k]);
  const upE = { house: "house", dscc: "dscc", sb: "opsb", cong: "cong", council: "council" };
  const next = nxt.length ? `<details class="pd" open><summary>Votes on next</summary><table class="pdl"><tbody>` + nxt.map(([jt, k, yr]) => {
      const d = D[k], rec = JUR[jt] && JUR[jt][d], f = rec ? jFlags(jt, d) : {};
      const tags = (jt === "dscc" ? (rec ? Object.entries(rec.offices).filter(([, o]) => o.dsa === "Y").map(([o]) => `<span class="flag dsa">Office ${o} · DSA</span>`).join("") : "")
        : (f.dsa ? `<span class="flag dsa">DSA-held</span>` : "") + (f.tl ? `<span class="flag">Open seat</span>` : "") + (rec && rec.party === "R" ? `<span class="flag">Rep. incumbent</span>` : ""));
      return `<tr><td>${yr}</td><td><button type="button" class="pdlink" data-up-e="${upE[jt]}" data-up-d="${esc(d)}" title="Open in Upcoming elections">${esc(JT[jt].name(d))}</button>${rec ? `<small>${rec.migs} members in good standing in the district</small>` : ""}<div class="tags">${tags}</div></td></tr>`;
    }).join("") + (D.c ? `<tr><td>2029</td><td>Council At-Large (two seats, parish-wide)</td></tr>` : "") + `</tbody></table></details>` : "";
  return demo + memb + votes + next;
}

// precinct table: header sort buttons and filters on the existing three columns
function renderActTable(rows, visible) {
  const { af, tf } = state.sum;
  const gapOf = x => d3.max((af === "all" || af === "any" ? (x.cs.length ? x.cs : ["E", "R", "I"]) : [af]).map(c => catStrength(x.r, c)));
  let list = rows.filter(visible).map(x => ({ ...x, s: gapOf(x) }));
  const val = x => tf.sk === "gap" ? x.s : tf.sk === "p" ? pName(x.r.p) : tf.sk === "loc" ? locOf(x.r) : x.r[tf.sk];
  list.sort((a, b) => { const va = val(a), vb = val(b); if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
    return typeof va === "string" ? tf.dir * va.localeCompare(vb, undefined, { numeric: true }) : tf.dir * (va - vb); });
  const sortName = { gap: "strongest gap first", p: "by precinct", loc: "by council / parish", wc: "by working class", sup: "by DSA vote", mem: "by membership" }[tf.sk];
  document.getElementById("actListTitle").textContent = `${list.length} precinct${list.length === 1 ? "" : "s"}${state.sum.brush ? " in your chart selection" : af === "all" ? " flagged" : af === "any" ? "" : ": " + CATS[af].label.toLowerCase()} · ${sortName}`;
  // header state
  document.querySelectorAll("#actList .tfs").forEach(b => { const on = b.dataset.k === tf.sk; b.classList.toggle("on", on); b.classList.toggle("asc", on && tf.dir > 0); });
  const body = document.getElementById("actBody");
  body.innerHTML = list.length ? list.slice(0, 300).map(x => `<tr data-p="${esc(x.r.p)}" tabindex="0" class="${x.r.p === state.sum.pSel ? "sel" : ""}"><td>${esc(pName(x.r.p))}<div class="tags">${x.cs.map(ctype).join("")}</div></td><td>${trio(x.r)}</td><td>${esc(x.r.dist.c || (isMetro(x.r.p) ? parishOf(x.r.p) : "–"))}</td></tr>`).join("") +
      (list.length > 300 ? `<tr><td colspan="3" class="xnone">Showing the first 300; narrow the filters to see the rest.</td></tr>` : "")
    : `<tr><td colspan="3"><p class="xnone">No precincts match. Clear the chart selection or change what Show includes.</p></td></tr>`;
  body.querySelectorAll("tr[data-p]").forEach(tr => { const go = () => { state.sum.pSel = tr.dataset.p; renderAct(); sFit([featById.get(tr.dataset.p)], true, 0.25); }; tr.addEventListener("click", go); tr.addEventListener("keydown", ev => { if (ev.key === "Enter") go(); }); });
}
document.querySelectorAll("#actList .tfs").forEach(b => b.addEventListener("click", () => {
  const tf = state.sum.tf, k = b.dataset.k;
  if (tf.sk === k) tf.dir = -tf.dir; else { tf.sk = k; tf.dir = k === "p" || k === "loc" ? 1 : -1; }
  renderAct();
}));
document.getElementById("actListTitle").addEventListener("dblclick", () => { state.sum.tf.sk = "gap"; state.sum.tf.dir = -1; renderAct(); });
document.getElementById("scClear").addEventListener("click", () => { state.sum.brush = null; state.sum.brushBox = null; renderAct(); });
document.querySelectorAll("[data-ps]").forEach(b => b.addEventListener("click", () => { state.sum.ps = b.dataset.ps; renderAct(); }));
document.getElementById("actColor").addEventListener("change", e => { state.sum.cm = e.target.value; renderAct(); });
["scX", "scY"].forEach(id => document.getElementById(id).addEventListener("change", e => { state.sum[id === "scX" ? "sx" : "sy"] = e.target.value; state.sum.brush = null; state.sum.brushBox = null; renderAct(); }));

function renderSum() { state.sum.tab === "run" ? renderRun() : renderAct(); }
function setSumTab(tab) {
  state.sum.tab = tab; saveSum();
  const r = tab === "run";
  document.getElementById("stab-run").setAttribute("aria-selected", r); document.getElementById("stab-run").tabIndex = r ? 0 : -1;
  document.getElementById("stab-act").setAttribute("aria-selected", !r); document.getElementById("stab-act").tabIndex = r ? -1 : 0;
  document.getElementById("runRail").hidden = !r; document.getElementById("actRail").hidden = r;
  document.getElementById("runControls").hidden = !r; document.getElementById("actControls").hidden = r;
  if (currentView === "summary") { slayout(); renderSum(); sFit(sumExtent(), false); }
}
document.getElementById("stab-run").addEventListener("click", () => setSumTab("run"));
document.getElementById("stab-act").addEventListener("click", () => setSumTab("act"));
document.querySelector("#view-summary .tabs").addEventListener("keydown", e => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const t = state.sum.tab === "run" ? "act" : "run"; setSumTab(t); document.getElementById("stab-" + t).focus(); }
});
document.getElementById("runElection").addEventListener("change", e => { state.sum.e = e.target.value; state.sum.sel = null; saveSum(); renderRun(); sFit(sumExtent(), true); });
document.getElementById("runColor").addEventListener("change", e => { state.sum.color = e.target.value; saveSum(); renderRun(); });
document.querySelectorAll("[data-rdw]").forEach(b => b.addEventListener("click", () => { dsccWeighted = b.dataset.rdw === "1"; try { localStorage.setItem("nola-dscc-w", dsccWeighted ? "1" : "0"); } catch (e) {} for (const k in sumCache) delete sumCache[k]; renderRun(); }));
document.getElementById("runTgt").addEventListener("click", () => { state.sum.tgt = !state.sum.tgt; renderRun(); });
document.querySelectorAll("[data-sg]").forEach(b => b.addEventListener("click", () => { state.sum.g = b.dataset.sg; saveSum(); renderSum(); }));

document.querySelectorAll("[data-af]").forEach(b => b.addEventListener("click", () => { state.sum.af = b.dataset.af; renderAct(); }));
document.getElementById("actGroup").addEventListener("change", e => { state.sum.group = e.target.value; saveSum(); renderAct(); });
let srt;
new ResizeObserver(() => { if (currentView !== "summary") return; clearTimeout(srt); srt = setTimeout(() => { slayout(); renderSum(); sFit(sumExtent(), false); }, 120); }).observe(ssvg.node().parentNode);
function showSummary() { setSumTab(state.sum.tab); }

/* ---------- app navigation ---------- */
const VIEWS = [
  { id: "election", label: "Election Data", desc: "Precinct results, upcoming districts, and trends" },
  { id: "membership", label: "Membership", desc: "Member density by ZIP code and district" },
  { id: "demographics", label: "Demographics", desc: "Renters, income, wage work, poverty and race" },
  { id: "summary", label: "Summary", desc: "Where to run candidates and where to organize" }
];
let currentView = "election";
(function setupNav() {
  const btn = document.getElementById("navBtn"), panel = document.getElementById("navPanel"), back = document.getElementById("navBack");
  const list = document.getElementById("navList");
  const draw = () => {
    list.innerHTML = VIEWS.map(v => `<button type="button" class="navitem" data-v="${v.id}"${v.id === currentView ? ' aria-current="page"' : ""}><span class="n">${esc(v.label)}</span><span class="d">${esc(v.desc)}</span></button>`).join("");
    list.querySelectorAll(".navitem").forEach(b => b.addEventListener("click", () => { showView(b.dataset.v); close(true); }));
    const v = VIEWS.find(v => v.id === currentView);
    document.getElementById("crumb").innerHTML = `<b>${esc(v.label)}</b>`;
  };
  const open = () => { draw(); panel.classList.add("open"); back.hidden = false; btn.setAttribute("aria-expanded", "true"); setTimeout(() => (list.querySelector('[aria-current]') || list.querySelector(".navitem")).focus(), 30); };
  const close = focusBtn => { panel.classList.remove("open"); back.hidden = true; btn.setAttribute("aria-expanded", "false"); if (focusBtn) btn.focus(); };
  btn.addEventListener("click", () => panel.classList.contains("open") ? close(false) : open());
  back.addEventListener("click", () => close(false));
  document.getElementById("navClose").addEventListener("click", () => close(true));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && panel.classList.contains("open")) close(true); });
  window.showView = id => {
    currentView = id;
    document.querySelectorAll("[data-view]").forEach(el => el.hidden = el.dataset.view !== id);
    draw();
    if (id === "membership") showMembership();
    else if (id === "demographics") showDemographics();
    else if (id === "summary") showSummary();
    else { layout(); render(false); fitCurrent(false); }
    try { history.replaceState(null, "", "#" + (id === "election" ? "" : id)); } catch (e) {}
  };
  draw();
})();

/* ---------- boot ---------- */
setupUp();
const startTab = (location.hash || "").replace("#", "");
if (startTab === "upcoming") state.tab = "up";
if (startTab === "trends") state.tab = "trends";
const startMembership = startTab === "membership";
layout();
setTab(state.tab, false);
if (startMembership) showView("membership");
if (startTab === "demographics") showView("demographics");
if (startTab === "summary") showView("summary");
let rt;
new ResizeObserver(() => { if (state.tab === "trends" || currentView !== "election") return; clearTimeout(rt); rt = setTimeout(() => { layout(); render(false); if (!state.selected) fitCurrent(false); }, 120); }).observe(svg.node().parentNode);
const recolor = () => currentView === "demographics" ? drender() : currentView === "summary" ? renderSum() : render(false);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", recolor);
new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
