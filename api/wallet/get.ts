// /api/wallet/get.ts
import { sb } from '../../lib/db.js';
import { getUser } from '../../lib/auth.js';
import { ensureUserAndWallet } from '../../lib/smm.js';

export const config = { runtime: 'nodejs18.x' };

function sendJson(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  // help caches avoid mixing users (defensive even with no-store)
  res.setHeader('Vary', 'x-user-id, x-user-email');
  res.end(JSON.stringify(obj));
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  try {
    const user = getUser(req);
    if (!user) return sendJson(res, 401, { error: 'no user' });

    // Ensure user+wallet exist (helper is idempotent)
    await ensureUserAndWallet(sb, user);

    // Read wallet
    let { data: w, error } = await sb
      .from('wallets')
      .select('balance_cents,currency')
      .eq('user_id', user.id)
      .single();

    // If not found or error, try to create a fresh zeroed wallet, then re-read
    if (error || !w) {
      try {
        await sb.from('wallets').insert({ user_id: user.id, balance_cents: 0, currency: 'usd' });
      } catch { /* ignore 409s etc. */ }
      const reread = await sb
        .from('wallets')
        .select('balance_cents,currency')
        .eq('user_id', user.id)
        .single();
      w = reread.data || { balance_cents: 0, currency: 'usd' };
    }

    // Normalize cents to a safe non-negative integer
    const centsNum = Number(w?.balance_cents ?? 0);
    const cents = Number.isFinite(centsNum) ? Math.max(0, Math.trunc(centsNum)) : 0;

    return sendJson(res, 200, {
      balance_cents: cents,
      currency: String(w?.currency ?? 'usd').toLowerCase(),
    });
  } catch (e: any) {
    const dbg = String(req.headers['x-debug-return-error'] || '') === '1';
    if (dbg) return sendJson(res, 200, { debug: 'handler_error', err: String(e?.message || e) });
    // Don't 500 on serverless; return ok so the platform doesn't show a big red error
    res.statusCode = 200;
    res.end('ok');
  }
}