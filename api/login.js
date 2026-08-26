// Vercel Serverless Function — exchanges a PingOne OIDC refresh token
// (extracted by the user from their own browser's localStorage) for a
// short-lived access token, and stores both in an httpOnly cookie.
//
// FPL migrated its web login to PingOne OIDC around the 2025/26 season.
// The old email/password POST + pl_profile/sessionid cookies no longer
// work. See project notes for the DevTools extraction one-liner.

const TOKEN_URL = 'https://account.premierleague.com/as/token';
const CLIENT_ID = process.env.FPL_OIDC_CLIENT_ID || 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { refresh_token } = req.body || {};
  if (!refresh_token || typeof refresh_token !== 'string' || refresh_token.length < 10) {
    res.status(400).json({ error: 'That doesn\'t look like a valid refresh token.' });
    return;
  }

  try {
    const form = new URLSearchParams();
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', refresh_token);
    form.set('client_id', CLIENT_ID);

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });

    const rawText = await tokenRes.text();
    let data;
    try { data = JSON.parse(rawText); } catch (e) { data = null; }

    if (!tokenRes.ok || !data || !data.access_token) {
      res.status(tokenRes.status || 502).json({
        error: 'Token exchange failed.',
        upstream_status: tokenRes.status,
        upstream_body: rawText.slice(0, 500),
      });
      return;
    }

    const bundled = Buffer.from(JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token || refresh_token,
      expires_in: data.expires_in || 3600,
      obtained_at: Date.now(),
    })).toString('base64');

    const maxAge = 60 * 60 * 12;

    res.setHeader(
      'Set-Cookie',
      `sw_fpl=${bundled}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the FPL token service.', detail: String(err) });
  }
};
