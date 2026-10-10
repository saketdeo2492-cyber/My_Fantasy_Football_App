#!/usr/bin/env node
// Snapshots every player's single-GW projection (projectPointsForGw — the
// same model behind the Point Projections table, ep_next blend and
// minutes-uncertainty discount included) plus each team's clean sheet %
// and implied goals, for one gameweek, to backtests/gw<N>-projections.json.
// Run it again closer to the deadline (after team news/injury updates
// land) to refresh the snapshot with the latest availability data — each
// run overwrites that gameweek's file and stamps a fresh `takenAt` time,
// so the JSON always reflects whichever run is most recent.
//
// Pairs with scripts/score-snapshot.js, which scores a snapshot like this
// one against the gameweek's actual results once it's finished.
//
// Usage: node scripts/snapshot-projections.js [eventId]
//   eventId defaults to the next unplayed gameweek.

const fs = require('fs');
const path = require('path');
const {
  projectPointsForGw,
  projectCleanSheetForGw,
  projectImpliedGoalsForGw,
  defaultEventId,
} = require('../api/_scoring');

const FPL_BASE = 'https://fantasy.premierleague.com/api';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; SquadWire/1.0)', Accept: 'application/json' };

async function fetchJson(pathSuffix) {
  const res = await fetch(`${FPL_BASE}/${pathSuffix}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`FPL API ${pathSuffix} returned ${res.status}`);
  return res.json();
}

async function main() {
  const [bs, fixtures] = await Promise.all([
    fetchJson('bootstrap-static/'),
    fetchJson('fixtures/'),
  ]);

  const eventId = parseInt(process.argv[2], 10) || defaultEventId(bs);
  if (!eventId) throw new Error('Could not determine a target gameweek.');

  const players = bs.elements
    .filter((p) => p.element_type >= 1 && p.element_type <= 4)
    .map((p) => ({
      id: p.id,
      web_name: p.web_name,
      team: p.team,
      element_type: p.element_type,
      status: p.status,
      chance_of_playing_next_round: p.chance_of_playing_next_round,
      projected_points: Math.round(projectPointsForGw(p, eventId, fixtures, bs) * 1000) / 1000,
    }));

  const teams = bs.teams.map((t) => ({
    id: t.id,
    name: t.name,
    clean_sheet_probability: projectCleanSheetForGw(t.id, eventId, fixtures, bs),
    implied_goals: projectImpliedGoalsForGw(t.id, eventId, fixtures, bs),
  }));

  const snapshot = {
    eventId,
    takenAt: new Date().toISOString(),
    players,
    teams,
  };

  const outDir = path.join(__dirname, '..', 'backtests');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `gw${eventId}-projections.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`Snapshot written to ${path.relative(process.cwd(), outPath)}`);
  console.log(`GW${eventId}: ${players.length} players, ${teams.length} teams, taken ${snapshot.takenAt}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
