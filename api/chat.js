// Vercel Serverless Function — backend for the floating AI chat assistant.
//
// Accepts POST { messages, squadContext }. `messages` is the conversation
// history (client already caps it to the last ~10 entries before sending —
// re-capped here too, since a client-side cap is a cost control, not a
// security boundary). `squadContext` is a compact, pre-computed summary the
// frontend assembles from its own already-running scoring model (squad,
// bank/free transfers, Team Score, top Recommender flags, Captain/Vice
// suggestion, next-GW point projections for the user's 15) — never the
// whole league's data, and never recomputed here.
//
// squadContext alone only covers the user's own 15 players plus a handful
// of Recommender-suggested replacements — it has nothing on the wider
// player pool. For genuinely open-ended questions ("who are the best
// forwards for GW4", or multi-gameweek ones like "best forwards over the
// next 5 gameweeks"), the model can instead call the get_top_players TOOL
// below, which this handler executes server-side (fetching bootstrap-
// static/fixtures directly from the FPL API — see fetchFplData — and
// running the same fixture-adjusted model as index.html, ported in
// ./_scoring.js — single-GW or GW_WEIGHTS-blended multi-GW depending on
// the tool's `horizon` argument) and feeds the result back to Claude for a
// second turn. squadContext-only questions never trigger this, so they
// cost exactly one API call, same as before this tool existed.
//
// The Anthropic API key is read from process.env.ANTHROPIC_API_KEY. It is
// never hardcoded and never returned to the client — only the assistant's
// reply text is.

const Anthropic = require('@anthropic-ai/sdk');
const { getTopPlayers } = require('./_scoring');

const MODEL = 'claude-haiku-4-5-20251001'; // current model ID for Claude Haiku 4.5
const MAX_HISTORY_MESSAGES = 10; // mirrors the client-side cap — enforced
  // again here since the client is not a trust boundary.
const MAX_MESSAGE_CHARS = 4000; // guards against a pathological single message
  // blowing up token usage/cost.
const MAX_TOOL_ROUNDS = 3; // hard cap on tool-call round-trips per request —
  // bounds cost/latency even if the model tries to chain tool calls.
const FPL_CACHE_TTL_MS = 5 * 60 * 1000; // bootstrap-static/fixtures barely
  // change minute-to-minute; matches api/fpl.js's own s-maxage=30 in spirit
  // (a bit longer here since a tool call is already a second full round-trip).

function buildSystemPrompt(squadContext) {
  return `You are the Squad Wire assistant — a Fantasy Premier League (FPL) strategy helper built directly into this app, not a general football chatbot.

Ground every answer in the SQUAD CONTEXT below whenever it's relevant — it's real data this app already computed from the official FPL API using its own scoring model (fixture-adjusted expected goals/assists/clean-sheets, a Team Score, transfer recommendations, a Captain/Vice-Captain suggestion, and point projections for this specific squad). Two fields cover multiple gameweeks, not just the next one: "squadMultiGwProjections" gives each of the user's own 15 players' projected points for each of the next few gameweeks individually, and "fixtureTicker" gives every Premier League team's upcoming opponent/home-or-away/difficulty for the same window — use these together for fixture-run, rotation-planning, or "who has the easiest run" questions rather than answering off only the next gameweek. Each entry in "recommenderFlags" also carries "inCandidates" — the same handful of suggested replacement players shown in that flag's card, each with their own blended score, average fixture difficulty, per-gameweek fixture-by-fixture breakdown, clean-sheet/DEFCON percentages, and underlying xG/xA or saves rates — use that to answer "why is [suggested player] rated higher than [other player]" follow-ups with the actual numbers behind the suggestion, not just the one-line reason. Cite specific numbers, player names, or reasons from that context rather than answering from generic football knowledge alone — e.g. "the Recommender already flags [Player] because [reason]" or "[Player]'s projected [X]pts this week is the highest of your options" is a much better answer than a generic one.

SQUAD CONTEXT only covers the user's own 15 players and a handful of suggested replacements — it is NOT the full player pool. For a genuinely open-ended question about players outside that scope — "who are the best forwards this gameweek", "top midfielders by assist chance", any "who should I consider" question not already answerable from SQUAD CONTEXT — call the get_top_players tool rather than guessing or declining. This includes multi-gameweek questions about the wider player pool, not just single-gameweek ones: pass "horizon" (e.g. 3 or 5) for "who's best over the next N gameweeks" questions — don't say multi-gameweek comparisons for the full player pool are beyond your scope, the tool covers exactly that too. Don't call the tool for questions SQUAD CONTEXT already answers (e.g. about the user's own squad or the Recommender's existing suggestions) — that data is already right here.

Be honest about genuine uncertainty rather than presenting a guess as fact. Rotation risk, a manager's team-selection choices, and whether a specific player actually starts are things this app's own model already flags as uncertain where relevant (e.g. its "New Signing / Limited Minutes — role uncertain" flag) — carry that same honesty into your answers. If the context doesn't clearly settle a question, say so and explain the tradeoff, rather than picking one side with false confidence.

Keep answers concise and conversational — this is a small chat widget, not a written report. A few sentences is usually enough; use short lists only when comparing multiple options.

=== SQUAD CONTEXT ===
${JSON.stringify(squadContext ?? {}, null, 2)}
=== END SQUAD CONTEXT ===`;
}

// Tool schema for Claude's native tool use. input_schema mirrors what
// getTopPlayers() (./_scoring.js) accepts.
const GET_TOP_PLAYERS_TOOL = {
  name: 'get_top_players',
  description: 'Look up the top FPL players for one gameweek (or, with `horizon` > 1, a blended multi-gameweek total), ranked by a chosen projected stat, from this app\'s own fixture-adjusted scoring model (the same model behind its Point Projections / Goals & Assists / Clean Sheet % tables for horizon=1, and the same blended model behind its transfer Recommender for horizon>1) — not general football knowledge. Use for open-ended "who\'s best" questions about players beyond the user\'s own squad and the Recommender\'s existing suggestions, for a single gameweek OR a multi-gameweek run (e.g. "best forwards over the next 5 gameweeks").',
  input_schema: {
    type: 'object',
    properties: {
      position: {
        type: 'string',
        enum: ['GKP', 'DEF', 'MID', 'FWD'],
        description: 'Restrict to one position. Omit for all positions. clean_sheet_probability ignores FWD automatically (forwards don\'t earn clean-sheet points).',
      },
      gameweek: {
        type: 'integer',
        description: 'The gameweek (event) number to project, e.g. 4 for "GW4". Omit for the next upcoming gameweek.',
      },
      sort_by: {
        type: 'string',
        enum: ['projected_points', 'goal_probability', 'assist_probability', 'clean_sheet_probability'],
        description: 'Which stat to rank players by.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        description: 'How many players to return. Default 15, max 25.',
      },
      horizon: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        description: 'How many gameweeks, starting at `gameweek`, to blend into one ranking — nearer gameweeks are weighted more heavily than farther ones. Default 1 (single gameweek, matches the Point Projections table exactly). Use e.g. 3 or 5 for "over the next N gameweeks" questions — this then matches the same blended multi-gameweek model the transfer Recommender uses, applied across every eligible player in the game, not just the user\'s squad.',
      },
    },
    required: ['sort_by'],
  },
};

// bootstrap-static/fixtures, fetched directly from the FPL API (same public
// endpoints api/fpl.js proxies) and cached in-memory per warm serverless
// instance — only hit when the model actually calls the tool, so a normal
// squadContext-only exchange never pays this cost.
let _fplCache = null; // { bs, fixtures, fetchedAt }
async function fetchFplData() {
  if (_fplCache && (Date.now() - _fplCache.fetchedAt) < FPL_CACHE_TTL_MS) return _fplCache;
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; SquadWire/1.0)', Accept: 'application/json' };
  const [bsRes, fixturesRes] = await Promise.all([
    fetch('https://fantasy.premierleague.com/api/bootstrap-static/', { headers }),
    fetch('https://fantasy.premierleague.com/api/fixtures/', { headers }),
  ]);
  if (!bsRes.ok || !fixturesRes.ok) throw new Error('Could not reach the FPL API for tool data.');
  const [bs, fixtures] = await Promise.all([bsRes.json(), fixturesRes.json()]);
  _fplCache = { bs, fixtures, fetchedAt: Date.now() };
  return _fplCache;
}

async function runTool(name, input) {
  if (name === 'get_top_players') {
    const { bs, fixtures } = await fetchFplData();
    return getTopPlayers(input || {}, bs, fixtures);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function sanitizeMessages(messages) {
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Chat is not configured on the server yet (missing ANTHROPIC_API_KEY).' });
    return;
  }

  const { messages, squadContext } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Provide a non-empty messages array.' });
    return;
  }

  const capped = sanitizeMessages(messages);
  if (capped.length === 0) {
    res.status(400).json({ error: 'No usable messages after validation.' });
    return;
  }
  // The API requires the first message in a request to have role "user".
  while (capped.length && capped[0].role !== 'user') capped.shift();
  if (capped.length === 0) {
    res.status(400).json({ error: 'Conversation must start with a user message.' });
    return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // Standard Anthropic tool-use loop: send the conversation with the tool
    // declared; if Claude responds with tool_use block(s) instead of (or
    // alongside) text, run each one server-side, feed the results back as a
    // tool_result message, and let Claude continue. A plain squadContext-only
    // reply never triggers this — it exits after the first response, same
    // one-API-call cost as before this tool existed.
    let messages = capped;
    let reply = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(squadContext),
        messages,
        tools: [GET_TOP_PLAYERS_TOOL],
      });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
        const textBlock = response.content.find((b) => b.type === 'text');
        // Falls back to a plain message only in the pathological case where
        // the round cap was hit with no text yet produced — shouldn't
        // happen in practice, but an empty reply would look like a bug.
        reply = textBlock ? textBlock.text : "I wasn't able to finish that lookup — try rephrasing or asking something more specific.";
        break;
      }

      const toolResults = await Promise.all(toolUses.map(async (tu) => {
        let content;
        try {
          content = JSON.stringify(await runTool(tu.name, tu.input));
        } catch (err) {
          content = JSON.stringify({ error: String((err && err.message) || err) });
        }
        return { type: 'tool_result', tool_use_id: tu.id, content };
      }));

      messages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: toolResults }];
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error('[api/chat] Anthropic API error:', err);
    const status = (err && typeof err.status === 'number') ? err.status : 502;
    res.status(status).json({
      error: 'Could not reach the AI assistant.',
      detail: String((err && err.message) || err),
    });
  }
};
