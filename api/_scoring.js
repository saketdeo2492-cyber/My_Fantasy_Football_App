// Server-side port of the subset of index.html's fixture-adjusted scoring
// model needed for api/chat.js's get_top_players tool (see buildSystemPrompt
// there for how the tool fits into the chat flow). This is deliberately a
// parallel port, not a require() of index.html — that file is browser JS
// (relies on `document`, DOM rendering, etc.) and isn't requireable from a
// Node serverless function. Kept in careful sync with index.html's own
// model: teamDefensiveFactor/teamAttackingFactor shrinkage, reliablePer90's
// position-average blending, the unified Poisson clean-sheet calculation,
// and the position-specific point formulas are all copied verbatim from
// there. If that model changes, mirror the change here too.

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const DEFCON_THRESHOLD = { 2: 10, 3: 12, 4: 12 };
const SAMPLE_FULL_CONFIDENCE_MINUTES = 600; // ~6.7 full matches
const MINUTES_UNCERTAINTY_DISCOUNT = 0.75;
const MIN_MINUTES_PACE_RATIO = 0.45;
const CLUB_TENURE_GRACE_MINUTES = 45;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function minutesWeightedAvg(players, valueFn) {
  let weightSum = 0, total = 0;
  players.forEach((e) => { const w = e.minutes || 0; weightSum += w; total += valueFn(e) * w; });
  return weightSum > 0 ? total / weightSum : null;
}

function gameweeksPlayedSoFar(bs) { return bs.events.filter((e) => e.finished).length; }

function sampleWeight(minutes) { return clamp((minutes || 0) / SAMPLE_FULL_CONFIDENCE_MINUTES, 0, 1); }
function teamSampleWeight(bs) { return sampleWeight(gameweeksPlayedSoFar(bs) * 90); }

const _positionAvgCache = new WeakMap();
function positionAvgPer90(elementType, field, bs) {
  let byBs = _positionAvgCache.get(bs);
  if (!byBs) { byBs = {}; _positionAvgCache.set(bs, byBs); }
  const key = elementType + '|' + field;
  if (!(key in byBs)) {
    const pool = bs.elements.filter((e) => e.element_type === elementType && (e.minutes || 0) > 0);
    const avg = minutesWeightedAvg(pool, (e) => parseFloat(e[field]) || 0);
    byBs[key] = avg == null ? 0 : avg;
  }
  return byBs[key];
}

function reliablePer90(e, field, bs) {
  const raw = parseFloat(e[field]) || 0;
  const w = sampleWeight(e.minutes);
  const prior = positionAvgPer90(e.element_type, field, bs);
  return raw * w + prior * (1 - w);
}

function teamDefensiveFactor(teamId, bs) {
  const PRIOR_XGC90 = 1.3;
  const defenders = bs.elements.filter((e) => e.team === teamId && (e.element_type === 1 || e.element_type === 2) && e.minutes > 0);
  const avg = minutesWeightedAvg(defenders, (e) => parseFloat(e.expected_goals_conceded_per_90) || PRIOR_XGC90);
  const raw = avg == null ? PRIOR_XGC90 : avg;
  const w = teamSampleWeight(bs);
  return raw * w + PRIOR_XGC90 * (1 - w);
}
function teamAttackingFactor(teamId, bs) {
  const PRIOR_XGI90 = 0.45;
  const attackers = bs.elements.filter((e) => e.team === teamId && (e.element_type === 3 || e.element_type === 4) && e.minutes > 0);
  const avg = minutesWeightedAvg(attackers, (e) => (parseFloat(e.expected_goals_per_90) || 0) + (parseFloat(e.expected_assists_per_90) || 0));
  const raw = avg == null ? PRIOR_XGI90 : avg;
  const w = teamSampleWeight(bs);
  return raw * w + PRIOR_XGI90 * (1 - w);
}

function fixtureAttackFactor(difficulty) { return 1 + (3 - difficulty) * 0.08; }
function fixtureConcedeFactor(difficulty) { return 1 + (difficulty - 3) * 0.08; }
function poissonZeroProb(lambda) { return Math.exp(-Math.max(0, lambda)); }
function poissonAtLeastOneProb(lambda) { return 1 - Math.exp(-Math.max(0, lambda)); }

function adjustedGoalsConceded(teamId, opponentTeamId, difficulty, bs) {
  const baseline = teamDefensiveFactor(teamId, bs);
  const oppFactor = clamp(teamAttackingFactor(opponentTeamId, bs) / 0.45, 0.5, 2.2);
  return baseline * fixtureConcedeFactor(difficulty) * oppFactor;
}
function opponentAttackFactor(opponentTeamId, difficulty, bs) {
  const fplFactor = fixtureAttackFactor(difficulty);
  const oppFactor = clamp(teamDefensiveFactor(opponentTeamId, bs) / 1.4, 0.5, 2.2);
  return fplFactor * oppFactor;
}

function defconHitProbability(per90rate, threshold) {
  const rate = parseFloat(per90rate) || 0;
  const k = 4 / threshold;
  return 1 / (1 + Math.exp(-k * (rate - threshold)));
}

function estimatedGamesPlayed(e) {
  const ppg = parseFloat(e.points_per_game) || 0;
  if (ppg > 0 && e.total_points > 0) return e.total_points / ppg;
  return e.starts || (e.minutes > 0 ? 1 : 0);
}
function avgMinutesPerGame(e) {
  const games = estimatedGamesPlayed(e);
  return games > 0 ? e.minutes / games : 0;
}
function availabilityMultiplier(e) {
  if (e.status === 'a') return 1;
  if (e.status === 'd') return (typeof e.chance_of_playing_next_round === 'number' ? e.chance_of_playing_next_round : 50) / 100;
  return 0.05;
}

function gameweeksSinceJoiningCurrentClub(e, bs, gwPlayed) {
  if (!e.team_join_date) return gwPlayed;
  const joinTime = new Date(e.team_join_date).getTime();
  if (isNaN(joinTime)) return gwPlayed;
  return bs.events.filter((ev) => ev.finished && new Date(ev.deadline_time || 0).getTime() >= joinTime).length;
}
function hasLimitedMinutesSample(e, bs) {
  const gwPlayed = gameweeksPlayedSoFar(bs);
  if (gwPlayed === 0) return false;
  const minutes = e.minutes || 0;
  const gwsAtClub = gameweeksSinceJoiningCurrentClub(e, bs, gwPlayed);
  const predatesCurrentClub = minutes > gwsAtClub * 90 + CLUB_TENURE_GRACE_MINUTES;
  const belowPace = minutes / (gwPlayed * 90) < MIN_MINUTES_PACE_RATIO;
  return predatesCurrentClub || belowPace;
}

// Single-fixture projected points, position-specific — mirrors index.html's
// playerFixtureScore().
function playerFixtureScore(p, fixture, bs) {
  const isHome = fixture.team_h === p.team;
  const oppId = isHome ? fixture.team_a : fixture.team_h;
  const difficulty = isHome ? fixture.team_h_difficulty : fixture.team_a_difficulty;
  const csProb = poissonZeroProb(adjustedGoalsConceded(p.team, oppId, difficulty, bs));
  const attFactor = opponentAttackFactor(oppId, difficulty, bs);
  const minsFactor = clamp(avgMinutesPerGame(p) / 90, 0.3, 1);
  const form = parseFloat(p.form) || 0;
  const xg90 = reliablePer90(p, 'expected_goals_per_90', bs);
  const xa90 = reliablePer90(p, 'expected_assists_per_90', bs);
  const defcon90 = reliablePer90(p, 'defensive_contribution_per_90', bs);

  let pts;
  if (p.element_type === 1) {
    const saves90 = reliablePer90(p, 'saves_per_90', bs);
    pts = 2 * minsFactor + csProb * 4 + (saves90 * minsFactor) / 3 + form * 0.25;
  } else if (p.element_type === 2) {
    const defconProb = defconHitProbability(defcon90, DEFCON_THRESHOLD[2]);
    const attackPts = (xg90 * 6 + xa90 * 3) * minsFactor * attFactor;
    pts = 2 * minsFactor + csProb * 4 + attackPts + defconProb * 2 + form * 0.2;
  } else if (p.element_type === 3) {
    const defconProb = defconHitProbability(defcon90, DEFCON_THRESHOLD[3]);
    const attackPts = (xg90 * 5 + xa90 * 3) * minsFactor * attFactor;
    pts = 2 * minsFactor + csProb * 1 + attackPts + defconProb * 2 + form * 0.25;
  } else {
    const defconProb = defconHitProbability(defcon90, DEFCON_THRESHOLD[4]);
    const attackPts = (xg90 * 4 + xa90 * 3) * minsFactor * attFactor;
    pts = 2 * minsFactor + attackPts + defconProb * 2 + form * 0.25;
  }
  return { points: Math.max(0, pts) * availabilityMultiplier(p) };
}

// Point projection for one player in one specific gameweek (sums DGW
// fixtures, blends in ep_next, applies the limited-minutes discount) —
// mirrors index.html's projectSingleGw() in 'ev' mode with no per-player
// history, the same simplification the Point Projections table itself
// uses for the full ~700-player pool (recency-weighted history isn't
// fetched for every player in the game, just season-long rates).
function projectPointsForGw(p, eventId, fixtures, bs) {
  const teamFixtures = fixtures.filter((f) => f.event === eventId && (f.team_h === p.team || f.team_a === p.team));
  let points = teamFixtures.reduce((sum, f) => sum + playerFixtureScore(p, f, bs).points, 0);
  if (teamFixtures.length > 0) {
    const epNext = parseFloat(p.ep_next);
    if (!isNaN(epNext)) points = points * 0.8 + epNext * 0.2;
  }
  if (hasLimitedMinutesSample(p, bs)) points *= MINUTES_UNCERTAINTY_DISCOUNT;
  return Math.max(0, points);
}

// Goal/assist probability for one player in one specific gameweek — mirrors
// index.html's projectionsRowForGw().
function projectGoalAssistForGw(p, eventId, fixtures, bs) {
  const teamFixtures = fixtures.filter((f) => f.event === eventId && (f.team_h === p.team || f.team_a === p.team));
  if (teamFixtures.length === 0) return { goalProb: null, assistProb: null };
  let sumXG = 0, sumXA = 0;
  teamFixtures.forEach((f) => {
    const isHome = f.team_h === p.team;
    const difficulty = isHome ? f.team_h_difficulty : f.team_a_difficulty;
    const oppId = isHome ? f.team_a : f.team_h;
    const attFactor = opponentAttackFactor(oppId, difficulty, bs);
    const minsFactor = clamp(avgMinutesPerGame(p) / 90, 0.3, 1);
    sumXG += reliablePer90(p, 'expected_goals_per_90', bs) * attFactor * minsFactor;
    sumXA += reliablePer90(p, 'expected_assists_per_90', bs) * attFactor * minsFactor;
  });
  return { goalProb: poissonAtLeastOneProb(sumXG), assistProb: poissonAtLeastOneProb(sumXA) };
}

// Clean sheet probability for one TEAM in one specific gameweek — mirrors
// index.html's teamCleanSheetRowForGw().
function projectCleanSheetForGw(teamId, eventId, fixtures, bs) {
  const teamFixtures = fixtures.filter((f) => f.event === eventId && (f.team_h === teamId || f.team_a === teamId));
  if (teamFixtures.length === 0) return null;
  let sumXGC = 0;
  teamFixtures.forEach((f) => {
    const isHome = f.team_h === teamId;
    const oppId = isHome ? f.team_a : f.team_h;
    const difficulty = isHome ? f.team_h_difficulty : f.team_a_difficulty;
    sumXGC += adjustedGoalsConceded(teamId, oppId, difficulty, bs);
  });
  return poissonZeroProb(sumXGC);
}

function defaultEventId(bs) {
  const next = bs.events.find((e) => e.is_next) || bs.events.find((e) => !e.finished);
  return next ? next.id : null;
}

// Entry point for the chat assistant's get_top_players tool (see
// api/chat.js). `position` is one of POS's values or falsy for all
// positions; `sort_by` is one of projected_points/goal_probability/
// assist_probability/clean_sheet_probability; `limit` is capped to 25.
// Pool is restricted to available (status 'a') players with any
// current-season minutes — same "has a real signal to rank on" filter
// index.html's findCandidates() uses — so the tool doesn't surface
// completely unproven bench players.
function getTopPlayers({ position, gameweek, sort_by, limit }, bs, fixtures) {
  const eventId = gameweek || defaultEventId(bs);
  if (!eventId) return { error: 'No upcoming gameweek to project — season may be over.' };
  const cappedLimit = clamp(Math.round(limit) || 15, 1, 25);

  const teamShort = {}; bs.teams.forEach((t) => { teamShort[t.id] = t.short_name; });
  let pool = bs.elements.filter((e) => e.status === 'a' && e.minutes > 0);
  if (position) pool = pool.filter((e) => POS[e.element_type] === position);

  let rows;
  if (sort_by === 'clean_sheet_probability') {
    pool = pool.filter((e) => e.element_type !== 4); // FWDs don't earn clean-sheet points
    rows = pool.map((e) => ({
      name: e.web_name, team: teamShort[e.team], position: POS[e.element_type],
      clean_sheet_probability: projectCleanSheetForGw(e.team, eventId, fixtures, bs),
    })).filter((r) => r.clean_sheet_probability != null);
    rows.sort((a, b) => b.clean_sheet_probability - a.clean_sheet_probability);
    rows.forEach((r) => { r.clean_sheet_probability = Math.round(r.clean_sheet_probability * 100) + '%'; });
  } else if (sort_by === 'goal_probability' || sort_by === 'assist_probability') {
    const outKey = sort_by;
    rows = pool.map((e) => {
      const { goalProb, assistProb } = projectGoalAssistForGw(e, eventId, fixtures, bs);
      const val = sort_by === 'goal_probability' ? goalProb : assistProb;
      return { name: e.web_name, team: teamShort[e.team], position: POS[e.element_type], [outKey]: val };
    }).filter((r) => r[outKey] != null);
    rows.sort((a, b) => b[outKey] - a[outKey]);
    rows.forEach((r) => { r[outKey] = Math.round(r[outKey] * 100) + '%'; });
  } else { // projected_points (default / fallback for an unrecognized sort_by)
    rows = pool.map((e) => ({
      name: e.web_name, team: teamShort[e.team], position: POS[e.element_type],
      projected_points: Math.round(projectPointsForGw(e, eventId, fixtures, bs) * 10) / 10,
    }));
    rows.sort((a, b) => b.projected_points - a.projected_points);
  }

  return { gameweek: eventId, sort_by: sort_by || 'projected_points', position: position || 'ALL', results: rows.slice(0, cappedLimit) };
}

module.exports = { getTopPlayers };
