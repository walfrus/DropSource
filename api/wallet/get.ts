// api/wallet/get.ts
import { sb } from '../../lib/db.js';
import { getUser } from '../../lib/auth.js';
import { ensureUserAndWallet } from '../../lib/smm.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  // help caches avoid mixing users (defensive even with no-store)
  res.setHeader('Vary', 'x-user-id, x-user-email');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  try {
    const user = getUser(req);
    if (!user) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'no user' }));
      return;
    }

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

    res.statusCode = 200;
    res.end(JSON.stringify({
      balance_cents: cents,
      currency: String(w?.currency ?? 'usd').toLowerCase(),
    }));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}