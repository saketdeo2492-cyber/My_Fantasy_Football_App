// Vercel Serverless Function — TEST-ONLY shortcut.
//
// Stores an access_token (lifted straight from FPL's own localStorage,
// no PingOne token exchange at all) into the sw_fpl cookie so we can
// check whether authenticated calls (my-team/, me/) work at all before
// building out the real refresh_token -> PingOne exchange flow.
//
// NOTE: the cookie payload here is intentionally the minimal
// {access_token, expires_at} shape, not the {access_token, refresh_token,
// expires_in, obtained_at} shape api/login.js writes. api/fpl.js's
// expiry check (obtained_at + expires_in) won't find those fields on a
// session written by this endpoint, so it will just treat the token as
// never-expired and pass it straight through until FPL itself rejects
// it with a 401 — there's no refresh_token here to refresh with anyway.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { access_token, expires_at } = req.body || {};

  if (!access_token || typeof access_token !== 'string') {
    res.status(400).json({ error: 'Provide access_token.' });
    return;
  }

  const bundled = Buffer.from(JSON.stringify({ access_token, expires_at })).toString('base64');
  const maxAge = 60 * 60 * 12;

  res.setHeader(
    'Set-Cookie',
    `sw_fpl=${bundled}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  res.status(200).json({ ok: true });
};
