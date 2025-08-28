// /api/debug/db-ping.ts
// Minimal DB health-check endpoint (no Square logic here).
// Verifies Supabase service-role connectivity and write perms.

import { sb } from '../../lib/db.js';

export const config = { runtime: 'nodejs18.x' };

// Local no-store helper to avoid import cycles / TS path issues
function noStore(res: any) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

export default async function handler(req: any, res: any) {
  // Allow GET/HEAD for health checks
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }

  try {
    noStore(res);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const out: any = {
      ok: true,
      time: new Date().toISOString(),
      supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || null,
    };

    // Read check (wallets count)
    try {
      const { count, error } = await sb
        .from('wallets')
        .select('*', { count: 'exact', head: true });
      out.wallets_count = typeof count === 'number' ? count : null;
      if (error) out.wallets_error = String(error?.message || error);
    } catch (e: any) {
      out.wallets_error = String(e?.message || e);
    }

    // Write check (insert into webhook_logs)
    try {
      const { error } = await sb.from('webhook_logs').insert({
        source: 'debug',
        event: 'db_ping',
        http_status: 200,
        payload: { note: 'hello from /api/debug/db-ping' }
      });
      out.can_write_webhook_logs = !error;
      if (error) out.webhook_logs_error = String(error?.message || error);
    } catch (e: any) {
      out.can_write_webhook_logs = false;
      out.webhook_logs_error = String(e?.message || e);
    }

    // HEAD returns headers only
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (e: any) {
    // Never explode on a debug route: surface the error in JSON.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: false,
      note: 'db-ping caught error',
      error: String(e?.message || e)
    }));
  }
}