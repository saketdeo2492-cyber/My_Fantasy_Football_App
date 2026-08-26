// Vercel Serverless Function — logs into FPL via PingOne's OAuth
// "password grant" (Resource Owner Password Credentials), sent directly
// to the token API endpoint rather than the DataDome-protected web login
// page. This is the flow mobile apps commonly use. Falls back to
// accepting a pasted refresh_token if email/password isn't provided.

const TOKEN_URL = 'https://account.premierleague.com/as/token';
const CLIENT_ID = process.env.FPL_OIDC_CLIENT_ID || 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { email, password, refresh_token } = req.body || {};

  try {
    const form = new URLSearchParams();

    if (email && password) {
      form.set('grant_type', 'password');
      form.set('username', email);
      form.set('password', password);
      form.set('client_id', CLIENT_ID);
      form.set('scope', 'openid profile email offline_access');
    } else if (refresh_token) {
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', refresh_token);
      form.set('client_id', CLIENT_ID);
    } else {
      res.status(400).json({ error: 'Provide either email+password or a refresh_token.' });
      return;
    }

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
        error: 'Login failed.',
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
