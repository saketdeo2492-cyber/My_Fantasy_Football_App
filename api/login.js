// Vercel Serverless Function — logs into FPL on the user's behalf.
//
// Flow:
//  1. Browser POSTs { email, password } to this endpoint over HTTPS.
//  2. We POST those credentials to FPL's own login service, server-side.
//  3. FPL responds with session cookies (pl_profile, sessionid, csrftoken).
//  4. We bundle just those into our OWN httpOnly cookie on our domain —
//     the browser never sees the raw FPL cookies, and our frontend JS
//     can't read this cookie back out (httpOnly), which limits XSS risk.
//  5. The password is never stored or logged — it exists only for the
//     duration of this single request.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  try {
    const form = new URLSearchParams();
    form.set('login', email);
    form.set('password', password);
    form.set('app', 'plfpl-web');
    form.set('redirect_uri', 'https://fantasy.premierleague.com/a/login');

    const loginRes = await fetch('https://users.premierleague.com/accounts/login/', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; SquadWire/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      body: form.toString(),
    });

    const location = loginRes.headers.get('location') || '';
    const failed = loginRes.status !== 302 || location.includes('access-denied') || location.includes('Login');

    // Node 20's fetch Headers supports getSetCookie(); fall back gracefully if not.
    const rawCookies = typeof loginRes.headers.getSetCookie === 'function'
      ? loginRes.headers.getSetCookie()
      : (loginRes.headers.get('set-cookie') ? [loginRes.headers.get('set-cookie')] : []);

    const wanted = {};
    rawCookies.forEach((c) => {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (['pl_profile', 'sessionid', 'csrftoken'].includes(name)) {
        wanted[name] = value;
      }
    });

    if (failed || !wanted.pl_profile) {
      res.status(401).json({ error: 'FPL login failed — check your email and password.' });
      return;
    }

    const bundled = Buffer.from(JSON.stringify(wanted)).toString('base64');
    const maxAge = 60 * 60 * 12; // 12 hours

    res.setHeader(
      'Set-Cookie',
      `sw_fpl=${bundled}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
    );
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach FPL login service.', detail: String(err) });
  }
};
