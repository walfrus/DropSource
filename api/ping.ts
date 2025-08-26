// /api/ping.ts
// Lightweight health check for uptime monitors and CI smoke tests.
// - Allows GET/HEAD, 405 for others
// - No-cache headers so you always see fresh state
// - Emits build/runtime hints (env, region, commit)

export default function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Type', 'application/json');

  const ts = Date.now();
  const body = {
    ok: true,
    ts,
    iso: new Date(ts).toISOString(),
    env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
    region: process.env.VERCEL_REGION || process.env.AWS_REGION || null,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    echo: req.query?.echo ?? null,
  } as const;

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.end();
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify(body));
}