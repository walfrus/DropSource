// /api/wallet/get.ts  — self-contained, no local imports
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs18.x' };

function sendJson(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  // help caches avoid mixing users (defensive)
  res.setHeader('Vary', 'x-user-id, x-user-email');
  res.end(JSON.stringify(obj));
}

function getUserFromHeaders(req: any) {
  const id = (req.headers?.['x-user-id'] ?? '').toString().trim();
  const emailHeader = req.headers?.['x-user-email'];
  const email = typeof emailHeader === 'string' ? emailHeader.trim() : null;
  if (!id) return null;
  return { id, email };
}

export default async function handler(req: any, res: any) {
  // Only GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  // Debug switch: if you send header x-debug-return-error: 1, we will echo the real error text
  const debugEcho = String(req.headers?.['x-debug-return-error'] || '') === '1';

  try {
    const user = getUserFromHeaders(req);
    if (!user) return sendJson(res, 401, { error: 'no user' });

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    // Service role client (server-only). No RLS issues.
    const sb = createClient(url, key, { auth: { persistSession: false } });

    // Ensure user row exists (idempotent)
    {
      const up = await sb
        .from('users')
        .upsert({ id: user.id, email: user.email ?? null }, { onConflict: 'id' })
        .select('id')
        .single();
      // ignore unique violation code 23505; throw others
      if (up.error && up.error.code !== '23505') throw up.error;
    }

    // Read wallet; create if not exists
    let w = (await sb
      .from('wallets')
      .select('user_id,balance_cents,currency')
      .eq('user_id', user.id)
      .maybeSingle()).data;

    if (!w) {
      const ins = await sb.from('wallets').insert({
        user_id: user.id,
        balance_cents: 0,
        currency: 'usd',
      });
      if (ins.error) throw ins.error;

      const reread = await sb
        .from('wallets')
        .select('user_id,balance_cents,currency')
        .eq('user_id', user.id)
        .maybeSingle();
      if (reread.error) throw reread.error;
      w = reread.data!;
    }

    // Normalize balance to a non-negative integer
    const centsNum = Number(w?.balance_cents ?? 0);
    const cents = Number.isFinite(centsNum) ? Math.max(0, Math.trunc(centsNum)) : 0;

    return sendJson(res, 200, {
      balance_cents: cents,
      currency: String(w?.currency ?? 'usd').toLowerCase(),
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Never crash the function; always return JSON so Vercel doesn’t show FUNCTION_INVOCATION_FAILED
    if (debugEcho) return sendJson(res, 200, { debug: 'handler_error', err: msg });
    return sendJson(res, 200, { error: 'server_error' });
  }
}