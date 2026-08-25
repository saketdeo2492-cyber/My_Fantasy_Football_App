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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':

git add .
git commit -m "improve login headers"
git push
