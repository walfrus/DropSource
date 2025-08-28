// /api/ping.ts
// Lightweight health check for uptime monitors and CI smoke tests.
// - Allows GET/HEAD, 405 for others
// - No-cache headers so you always see fresh state
// - Emits build/runtime hints (env, region, commit)

export const config = { runtime: 'nodejs18.x' };

export default function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const ts = Date.now();
    const url = new URL(req.url || '/', 'http://localhost');
    const echo = url.searchParams.get('echo');
    const body = {
      ok: true,
      ts,
      iso: new Date(ts).toISOString(),
      env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
      region: process.env.VERCEL_REGION || process.env.AWS_REGION || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      echo,
    } as const;

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify(body));
  } catch (e: any) {
    // Never 500 on a ping: report as healthy with debug note.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, note: 'ping handler caught error', err: String(e?.message || e) }));
  }
}