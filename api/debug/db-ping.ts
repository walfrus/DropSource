// /api/debug/db-ping.ts
// Minimal DB health-check endpoint (no Square logic here).
// Verifies Supabase service-role connectivity and write perms.

import { createClient } from '@supabase/supabase-js';

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
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const srv = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const anon = process.env.SUPABASE_ANON_KEY || '';

    const out: any = {
      ok: true,
      time: new Date().toISOString(),
      supabase_url: url || null,
      have_env: { url: !!url, service_role: !!srv, anon: !!anon },
      node: process.version,
    };

    // Lazy-create client so this route never crashes when env is missing
    let sb: any = null;
    if (url && (srv || anon)) {
      sb = createClient(url, srv || anon, { auth: { persistSession: false } });
    }

    // Read check (wallets count)
    if (sb) {
      try {
        const { count, error } = await sb
          .from('wallets')
          .select('*', { count: 'exact', head: true });
        out.wallets_count = typeof count === 'number' ? count : null;
        if (error) out.wallets_error = String(error?.message || error);
      } catch (e: any) {
        out.wallets_error = String(e?.message || e);
      }
    } else {
      out.wallets_error = 'no_supabase_client';
    }

    // Write check (insert into webhook_logs)
    if (sb) {
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
    } else {
      out.can_write_webhook_logs = false;
      out.webhook_logs_error = 'no_supabase_client';
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

export const config = { runtime: 'nodejs' };