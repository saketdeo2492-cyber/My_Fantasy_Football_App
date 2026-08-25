// Vercel Serverless Function — proxies requests to the official FPL API.
// Runs server-side, so there's no browser CORS restriction here at all.
// The frontend calls  /api/fpl?path=<endpoint>  instead of hitting
// fantasy.premierleague.com directly.

const ALLOWED_PREFIXES = [
  'bootstrap-static/',
  'fixtures/',
  'fixtures',
  'entry/',       // entry/{id}/  entry/{id}/event/{gw}/picks/  entry/{id}/history/  entry/{id}/transfers/
  'event/',       // event/{gw}/live/
  'element-summary/',
];

// Endpoints under these prefixes require the logged-in manager's session
// cookie (see api/login.js) — they return per-user data FPL won't hand out
// on the public API.
const AUTH_PREFIXES = ['my-team/'];

function readSessionCookies(req) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith('sw_fpl='));
  if (!match) return null;
  try {
    const raw = Buffer.from(match.slice('sw_fpl='.length), 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  const { path } = req.query;

  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'Missing "path" query parameter.' });
    return;
  }

  const needsAuth = AUTH_PREFIXES.some((p) => path.startsWith(p));
  const allowed = needsAuth || ALLOWED_PREFIXES.some((p) => path.startsWith(p));
  if (!allowed) {
    res.status(400).json({ error: 'That FPL endpoint is not on the allowlist.' });
    return;
  }

  const upstreamUrl = `https://fantasy.premierleague.com/api/${path}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; SquadWire/1.0)',
    Accept: 'application/json',
  };

  if (needsAuth) {
    const cookies = readSessionCookies(req);
    if (!cookies) {
      res.status(401).json({ error: 'Not logged in. Log in with your FPL account first.' });
      return;
    }
    headers.Cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  try {
    const upstream = await fetch(upstreamUrl, { headers });

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: `FPL API returned ${upstream.status} for ${path}`,
      });
      return;
    }

    const data = await upstream.json();

    // Light caching: FPL data doesn't need to be fetched fresh on every
    // single click. 30s cache, serve-stale-while-revalidating for a minute.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the FPL API.', detail: String(err) });
  }
};
