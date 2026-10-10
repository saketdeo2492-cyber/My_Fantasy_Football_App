#!/usr/bin/env node
// Snapshots every player's single-GW projection (projectPointsForGw — the
// same model behind the Point Projections table, ep_next blend and
// minutes-uncertainty discount included) plus each team's clean sheet %
// and implied goals, for one gameweek, to backtests/gw<N>-projections.json.
// Run it again closer to the deadline (after team news/injury updates
// land) to refresh the snapshot with the latest availability data — each
// run overwrites that gameweek's file and stamps a fresh `fetchedAt` time,
// so the JSON always reflects whichever run is most recent. No caching of
// any kind happens here or in api/_scoring.js: every run is two plain
// fetch() calls against the live FPL API, and nothing from a previous
// run is read back in except to print the before/overwrite diff below.
// (The FPL API's own CDN does cache bootstrap-static/ for up to 5 minutes
// — `cache-control: max-age=300` — so two runs inside that window can
// legitimately return byte-identical upstream data; that's FPL's edge
// cache, not anything this script does. This script now checks the
// response's own `age` header and, if the cached copy is already older
// than STALE_AGE_THRESHOLD, waits out the rest of the cache's max-age
// (plus a small margin) and refetches once, so a run close to the
// deadline doesn't silently work off a stale cached copy.)
//
// Per player this stores both projEV (assume plays — status forced to
// 'a' before scoring, so the doubt/injury discount is skipped) and
// projAvail (the real, status-aware projection, same as before) side by
// side, plus status/chance_of_playing_next_round/news, so a later
// comparison can isolate how much of any miss was "the model's fixture
// read was wrong" (projEV) vs. "the availability discount was wrong"
// (the projEV/projAvail gap).
//
// Before overwriting an existing snapshot for this gameweek, prints every
// player whose status, chance_of_playing_next_round, or news changed
// since that file was last written — the team-news diff that's the whole
// point of re-running this close to the deadline.
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
const CDN_MAX_AGE = 300; // FPL's own cache-control: max-age=300 on bootstrap-static/
const STALE_AGE_THRESHOLD = 240; // re-fetch if the cached copy is already this old
const EXTRA_WAIT_SECONDS = 5; // margin past the cache's own expiry before refetching

async function fetchJson(pathSuffix) {
  const res = await fetch(`${FPL_BASE}/${pathSuffix}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`FPL API ${pathSuffix} returned ${res.status}`);
  return res.json();
}

// Fetches bootstrap-static/ and also returns its `date`/`age` response
// headers — `age` is how many seconds old FPL's own CDN-cached copy
// already was when it served this response (see cache-control: max-age=300
// on that endpoint). Used to detect and work around the fact that two
// fetches inside that 5-minute window can return byte-identical data
// regardless of real team-news changes upstream.
async function fetchBootstrapWithMeta() {
  const res = await fetch(`${FPL_BASE}/bootstrap-static/`, { headers: HEADERS });
  if (!res.ok) throw new Error(`FPL API bootstrap-static/ returned ${res.status}`);
  const data = await res.json();
  const age = parseInt(res.headers.get('age'), 10);
  return { data, date: res.headers.get('date'), age: Number.isFinite(age) ? age : null };
}

function printChangesFromPreviousSnapshot(outPath, newPlayers) {
  if (!fs.existsSync(outPath)) return;
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch (e) {
    return; // unreadable/corrupt previous file — nothing to diff against
  }
  const prevById = new Map((prev.players || []).map((p) => [p.id, p]));
  const changes = [];
  for (const p of newPlayers) {
    const old = prevById.get(p.id);
    if (!old) continue;
    const statusChanged = old.status !== p.status;
    const copChanged = old.chance_of_playing_next_round !== p.chance_of_playing_next_round;
    const newsChanged = (old.news || '') !== (p.news || '');
    if (statusChanged || copChanged || newsChanged) {
      changes.push({ id: p.id, name: p.web_name, old, next: p, statusChanged, copChanged, newsChanged });
    }
  }
  if (!changes.length) {
    console.log('No status/chance_of_playing_next_round/news changes since the previous snapshot.');
    return;
  }
  console.log(`${changes.length} player(s) changed since the previous snapshot (taken ${prev.fetchedAt || prev.takenAt || 'unknown time'}):`);
  for (const c of changes) {
    const parts = [];
    if (c.statusChanged) parts.push(`status ${c.old.status} -> ${c.next.status}`);
    if (c.copChanged) parts.push(`chance_of_playing_next_round ${c.old.chance_of_playing_next_round} -> ${c.next.chance_of_playing_next_round}`);
    if (c.newsChanged) parts.push(`news "${c.old.news || ''}" -> "${c.next.news || ''}"`);
    console.log(`  ${c.name} (id ${c.id}): ${parts.join(', ')}`);
  }
}

async function main() {
  const [bsMeta0, fixtures] = await Promise.all([
    fetchBootstrapWithMeta(),
    fetchJson('fixtures/'),
  ]);

  let bsMeta = bsMeta0;
  console.log(`bootstrap-static/ response: date=${bsMeta.date}  age=${bsMeta.age}s`);

  if (bsMeta.age != null && bsMeta.age > STALE_AGE_THRESHOLD) {
    const waitSeconds = Math.max(0, CDN_MAX_AGE - bsMeta.age + EXTRA_WAIT_SECONDS);
    console.log(
      `Data age ${bsMeta.age}s exceeds the ${STALE_AGE_THRESHOLD}s threshold -- waiting ${waitSeconds}s ` +
      `(${CDN_MAX_AGE} - ${bsMeta.age} + ${EXTRA_WAIT_SECONDS}) for FPL's CDN cache to roll over, then refetching...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    bsMeta = await fetchBootstrapWithMeta();
    console.log(`Refetched bootstrap-static/: date=${bsMeta.date}  age=${bsMeta.age}s`);
  }

  const bs = bsMeta.data;
  const eventId = parseInt(process.argv[2], 10) || defaultEventId(bs);
  if (!eventId) throw new Error('Could not determine a target gameweek.');

  const players = bs.elements
    .filter((p) => p.element_type >= 1 && p.element_type <= 4)
    .map((p) => {
      const projAvail = projectPointsForGw(p, eventId, fixtures, bs);
      const projEV = projectPointsForGw({ ...p, status: 'a' }, eventId, fixtures, bs);
      return {
        id: p.id,
        web_name: p.web_name,
        team: p.team,
        element_type: p.element_type,
        status: p.status,
        chance_of_playing_next_round: p.chance_of_playing_next_round,
        news: p.news || '',
        projEV: Math.round(projEV * 1000) / 1000,
        projAvail: Math.round(projAvail * 1000) / 1000,
      };
    });

  const teams = bs.teams.map((t) => ({
    id: t.id,
    name: t.name,
    clean_sheet_probability: projectCleanSheetForGw(t.id, eventId, fixtures, bs),
    implied_goals: projectImpliedGoalsForGw(t.id, eventId, fixtures, bs),
  }));

  const transfersInEventSum = bs.elements.reduce((sum, e) => sum + (e.transfers_in_event || 0), 0);
  const nonAvailableCount = bs.elements.filter((e) => e.element_type >= 1 && e.element_type <= 4 && e.status !== 'a').length;

  const outDir = path.join(__dirname, '..', 'backtests');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `gw${eventId}-projections.json`);

  let prevSnapshot = null;
  if (fs.existsSync(outPath)) {
    try { prevSnapshot = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { /* unreadable — treated as no previous snapshot */ }
  }
  if (prevSnapshot && typeof prevSnapshot.transfersInEventSum === 'number') {
    const matches = prevSnapshot.transfersInEventSum === transfersInEventSum;
    console.log(
      `transfersInEventSum vs previous snapshot: ${matches ? 'MATCHES' : 'DIFFERS'} ` +
      `(previous=${prevSnapshot.transfersInEventSum}, current=${transfersInEventSum})`
    );
  } else {
    console.log('No previous snapshot (or no transfersInEventSum on it) to compare transfersInEventSum against.');
  }

  printChangesFromPreviousSnapshot(outPath, players);

  const snapshot = {
    eventId,
    fetchedAt: new Date().toISOString(),
    bootstrapResponseDate: bsMeta.date,
    bootstrapResponseAge: bsMeta.age,
    refetchedForFreshness: bsMeta !== bsMeta0,
    transfersInEventSum,
    nonAvailableCount,
    players,
    teams,
  };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

  console.log(`Snapshot written to ${path.relative(process.cwd(), outPath)}`);
  console.log(`GW${eventId}: ${players.length} players, ${teams.length} teams, taken ${snapshot.fetchedAt}`);
  console.log(`transfersInEventSum=${transfersInEventSum}  nonAvailableCount=${nonAvailableCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
