// Vercel Serverless Function — accepts a session cookie you copied from
// your own browser (after logging into FPL normally there) and stores it
// the same way api/login.js would have, minus the blocked server-side
// login step entirely.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { pl_profile } = req.body || {};
  if (!pl_profile || typeof pl_profile !== 'string' || pl_profile.length < 10) {
    res.status(400).json({ error: 'That doesn\'t look like a valid pl_profile cookie value.' });
    return;
  }

  const bundled = Buffer.from(JSON.stringify({ pl_profile })).toString('base64');
  const maxAge = 60 * 60 * 12; // 12 hours

  res.setHeader(
    'Set-Cookie',
    `sw_fpl=${bundled}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  res.status(200).json({ ok: true });
};
