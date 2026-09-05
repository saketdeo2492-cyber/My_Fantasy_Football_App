// Vercel Serverless Function — backend for the floating AI chat assistant.
//
// Accepts POST { messages, squadContext }. `messages` is the conversation
// history (client already caps it to the last ~10 entries before sending —
// re-capped here too, since a client-side cap is a cost control, not a
// security boundary). `squadContext` is a compact, pre-computed summary the
// frontend assembles from its own already-running scoring model (squad,
// bank/free transfers, Team Score, top Recommender flags, Captain/Vice
// suggestion, next-GW point projections for the user's 15) — never the
// whole league's data, and never recomputed here; this endpoint has no
// access to bootstrap-static/fixtures itself.
//
// The Anthropic API key is read from process.env.ANTHROPIC_API_KEY. It is
// never hardcoded and never returned to the client — only the assistant's
// reply text is.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001'; // current model ID for Claude Haiku 4.5
const MAX_HISTORY_MESSAGES = 10; // mirrors the client-side cap — enforced
  // again here since the client is not a trust boundary.
const MAX_MESSAGE_CHARS = 4000; // guards against a pathological single message
  // blowing up token usage/cost.

function buildSystemPrompt(squadContext) {
  return `You are the Squad Wire assistant — a Fantasy Premier League (FPL) strategy helper built directly into this app, not a general football chatbot.

Ground every answer in the SQUAD CONTEXT below whenever it's relevant — it's real data this app already computed from the official FPL API using its own scoring model (fixture-adjusted expected goals/assists/clean-sheets, a Team Score, transfer recommendations, a Captain/Vice-Captain suggestion, and next-gameweek point projections for this specific squad). Cite specific numbers, player names, or reasons from that context rather than answering from generic football knowledge alone — e.g. "the Recommender already flags [Player] because [reason]" or "[Player]'s projected [X]pts this week is the highest of your options" is a much better answer than a generic one.

Be honest about genuine uncertainty rather than presenting a guess as fact. Rotation risk, a manager's team-selection choices, and whether a specific player actually starts are things this app's own model already flags as uncertain where relevant (e.g. its "New Signing / Limited Minutes — role uncertain" flag) — carry that same honesty into your answers. If the context doesn't clearly settle a question, say so and explain the tradeoff, rather than picking one side with false confidence.

Keep answers concise and conversational — this is a small chat widget, not a written report. A few sentences is usually enough; use short lists only when comparing multiple options.

=== SQUAD CONTEXT ===
${JSON.stringify(squadContext ?? {}, null, 2)}
=== END SQUAD CONTEXT ===`;
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
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: buildSystemPrompt(squadContext),
      messages: capped,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    res.status(200).json({ reply: textBlock ? textBlock.text : '' });
  } catch (err) {
    console.error('[api/chat] Anthropic API error:', err);
    const status = (err && typeof err.status === 'number') ? err.status : 502;
    res.status(status).json({
      error: 'Could not reach the AI assistant.',
      detail: String((err && err.message) || err),
    });
  }
};
