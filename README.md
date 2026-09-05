# Squad Wire

FPL squad viewer + transfer recommender. The frontend never talks to
fantasy.premierleague.com directly — it calls `/api/fpl`, a serverless
function in this project that fetches FPL data server-side and relays it
back. That's what makes this actually work: no browser CORS restriction
applies to server-to-server requests.

## Deploy (you already have a Vercel account — no GitHub needed)

1. Unzip this project somewhere on your machine.
2. Open a terminal in that folder.
3. Run:
   ```
   npx vercel
   ```
4. It'll ask you to log in (opens a browser) and a few setup questions —
   defaults are fine for all of them (link to a new project, no framework
   detected is correct, don't override any settings).
5. Once it finishes, it prints a live URL — that's your app.

To push updates later: `npx vercel --prod` from the same folder.

## Optional: GitHub instead

If you'd rather have it auto-redeploy on every change:
1. Create a new GitHub repo, push this folder to it.
2. In the Vercel dashboard → **Add New Project** → import that repo.
3. Deploy — no config needed, Vercel detects the `/api` folder automatically.

## How it works

- `index.html` — the app itself (squad table, ticker, transfer recommender)
- `api/fpl.js` — serverless function. Takes `?path=<fpl endpoint>`, fetches
  `https://fantasy.premierleague.com/api/<path>` server-side, returns the
  JSON. Has a small allowlist of endpoint prefixes so it can't be used as
  an open proxy to arbitrary URLs.

## Auth model (login feature)

- `api/login.js` — takes `{ email, password }`, logs into FPL's own login
  service server-side, and on success sets an httpOnly `sw_fpl` cookie on
  *this app's* domain containing the FPL session cookies (base64-encoded
  JSON). The password itself is never stored or logged anywhere.
- `api/fpl.js` — for paths under `my-team/`, reads that cookie and forwards
  the embedded FPL cookies to fantasy.premierleague.com as the `Cookie`
  header, so the request is authenticated as you.
- `api/logout.js` — clears the cookie.
- `api/session.js` — lets the frontend check "am I logged in?" on page load
  without needing to know your team ID yet.

This is unofficial — it uses FPL's reverse-engineered login flow (there's
no public documentation for it from FPL), so it could in theory break if
FPL changes that flow. It's the same technique several open-source FPL
tools use.

## Chat assistant (floating chat bubble)

- `api/chat.js` — takes `{ messages, squadContext }` (both assembled
  client-side — `squadContext` is a compact summary of the app's own
  already-computed data: squad, bank/free transfers, Team Score, top
  Recommender flags, Captain/Vice suggestion, next-GW point projections),
  calls Claude (`claude-haiku-4-5`) via the Anthropic SDK, and returns the
  reply text. Requires an `ANTHROPIC_API_KEY` environment variable set in
  the Vercel project (Settings → Environment Variables) — the chat bubble
  shows a clear error if it's missing, and the key itself is never sent to
  the browser. Conversation history is capped to the last 10 messages per
  request (client- and server-side) to bound cost.

## Extending it

Some ideas for next passes:
- Fixture-difficulty weighting in the recommender (not just form/next-GW points)
- Multi-gameweek horizon instead of just next fixture
- Chip awareness (don't suggest transfers if Wildcard/Free Hit is active)
- A "sell now, upgrade later" two-step transfer path for saving toward a premium
- Actually submitting transfers (not just recommending them) via the authenticated session
