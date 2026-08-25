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

module.exports = async (req, res) => {
  const { path } = req.query;

  if (!path || typeof path !== 'string') {
    res.status(400).json({ error: 'Missing "path" query parameter.' });
    return;
  }

  const allowed = ALLOWED_PREFIXES.some((p) => path.startsWith(p));
  if (!allowed) {
    res.status(400).json({ error: 'That FPL endpoint is not on the allowlist.' });
    return;
  }

  const upstreamUrl = `https://fantasy.premierleague.com/api/${path}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SquadWire/1.0)',
        Accept: 'application/json',
      },
    });

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
