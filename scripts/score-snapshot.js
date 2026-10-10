#!/usr/bin/env node
// Scores a snapshot written by scripts/snapshot-projections.js against
// that gameweek's actual results (event/<N>/live/), once it's finished.
// Reports mean bias (projected - actual) and Spearman correlation by
// position, over players who actually started — the same backtest
// methodology used to calibrate the goals-conceded deduction and
// per-position form weights, just automated for one gameweek at a time
// instead of a manual GW1-5 pull.
//
// Usage: node scripts/score-snapshot.js [path-to-snapshot.json]
//   defaults to backtests/gw6-projections.json

const fs = require('fs');
const path = require('path');

const FPL_BASE = 'https://fantasy.premierleague.com/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; SquadWire/1.0)', Accept: 'application/json' };
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

async function fetchJson(pathSuffix) {
  const res = await fetch(`${FPL_BASE}/${pathSuffix}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`FPL API ${pathSuffix} returned ${res.status}`);
  return res.json();
}

// Standard rank-based Spearman, average-ranking ties — same implementation
// used throughout this project's manual backtests.
function spearman(xs, ys) {
  const n = xs.length;
  function rank(vals) {
    const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    const ranks = new Array(vals.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && vals[order[j + 1]] === vals[order[i]]) j++;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
      i = j + 1;
    }
    return ranks;
  }
  const rx = rank(xs);
  const ry = rank(ys);
  const meanRx = rx.reduce((a, b) => a + b, 0) / n;
  const meanRy = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - meanRx) * (ry[i] - meanRy);
    sx += (rx[i] - meanRx) ** 2;
    sy += (ry[i] - meanRy) ** 2;
  }
  return sx > 0 && sy > 0 ? cov / Math.sqrt(sx * sy) : NaN;
}

async function main() {
  const snapshotPath = process.argv[2] || path.join(__dirname, '..', 'backtests', 'gw6-projections.json');
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`No snapshot at ${snapshotPath} — run scripts/snapshot-projections.js first.`);
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const { eventId } = snapshot;

  const bs = await fetchJson('bootstrap-static/');
  const event = bs.events.find((e) => e.id === eventId);
  if (event && !event.finished) {
    console.warn(`Warning: GW${eventId} is not flagged finished yet in bootstrap-static — scores below may be partial/live, not final.`);
  }

  const live = await fetchJson(`event/${eventId}/live/`);
  const actualById = new Map(live.elements.map((le) => [le.id, le.stats]));

  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of snapshot.players) {
    const stats = actualById.get(p.id);
    if (!stats || stats.starts !== 1) continue; // only confirmed starters, matching the manual GW1-5 backtests
    byPos[p.element_type].push({ id: p.id, name: p.web_name, projected: p.projected_points, actual: stats.total_points });
  }

  console.log(`Scoring GW${eventId} snapshot (taken ${snapshot.takenAt}) against event/${eventId}/live/\n`);
  console.log(`${'Pos'.padEnd(5)}${'N'.padStart(5)}${'MeanProj'.padStart(10)}${'MeanActual'.padStart(12)}${'Bias'.padStart(9)}${'Spearman'.padStart(10)}`);
  for (const et of [1, 2, 3, 4]) {
    const rows = byPos[et];
    if (!rows.length) {
      console.log(`${POS[et].padEnd(5)}  no starters found yet for this position`);
      continue;
    }
    const meanProj = rows.reduce((s, r) => s + r.projected, 0) / rows.length;
    const meanActual = rows.reduce((s, r) => s + r.actual, 0) / rows.length;
    const rho = spearman(rows.map((r) => r.projected), rows.map((r) => r.actual));
    console.log(
      `${POS[et].padEnd(5)}${String(rows.length).padStart(5)}${meanProj.toFixed(3).padStart(10)}${meanActual.toFixed(3).padStart(12)}${(meanProj - meanActual).toFixed(3).padStart(9)}${rho.toFixed(4).padStart(10)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
