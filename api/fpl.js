// Vercel Serverless Function — proxies requests to the official FPL API.
// For authenticated endpoints (my-team/, me/), sends an
// Authorization: Bearer <access_token> header using the PingOne OIDC
// token stored (by api/login.js) in the sw_fpl cookie, auto-refreshing
// it against PingOne's token endpoint if it's expired.

const ALLOWED_PREFIXES = [
  'bootstrap-static/',
  'fixtures/',
  'fixtures',
  'entry/',
  'event/',
  'element-summary/',
];
const AUTH_PREFIXES = ['my-team/', 'me/'];

const TOKEN_URL = 'https://account.premierleague.com/as/token';
const CLIENT_ID = process.env.FPL_OIDC_CLIENT_ID || 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';

function readSession(req) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith('sw_fpl='));
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match.slice('sw_fpl='.length), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

async function refreshAccessToken(refresh_token) {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refresh_token);
  form.set('client_id', CLIENT_ID);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok || !data || !data.access_token) {
    throw new Error(`Refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
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

  let newCookieToSet = null;

  if (needsAuth) {
    const session = readSession(req);
    if (!session) {
      res.status(401).json({ error: 'Not connected. Paste your refresh token first.' });
      return;
    }

    let accessToken = session.access_token;
    const isExpired = Date.now() > (session.obtained_at + (session.expires_in - 60) * 1000);

    if (isExpired) {
      try {
        const refreshed = await refreshAccessToken(session.refresh_token);
        accessToken = refreshed.access_token;
        const updatedSession = {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || session.refresh_token,
          expires_in: refreshed.expires_in || 3600,
          obtained_at: Date.now(),
        };
        newCookieToSet = Buffer.from(JSON.stringify(updatedSession)).toString('base64');
      } catch (e) {
        res.status(401).json({ error: 'Session expired. Please reconnect.', detail: String(e) });
        return;
      }
    }

    headers.Authorization = `Bearer ${accessToken}`;
  }

  try {
    const upstream = await fetch(upstreamUrl, { headers });

    if (newCookieToSet) {
      res.setHeader('Set-Cookie', `sw_fpl=${newCookieToSet}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
    }

    if (!upstream.ok) {
      const bodyText = await upstream.text();
      res.status(upstream.status).json({
        error: `FPL API returned ${upstream.status} for ${path}`,
        detail: bodyText.slice(0, 300),
      });
      return;
    }

    const data = await upstream.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the FPL API.', detail: String(err) });
  }
};
