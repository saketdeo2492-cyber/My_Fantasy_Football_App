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
const CLIENT_ID = process.env.FPL_OIDC_CLIENT_ID || 'fpl-web';

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

  const needsAuth =
