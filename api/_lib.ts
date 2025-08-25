// api/_lib.ts
import { createClient } from '@supabase/supabase-js';
import type { NextApiRequest } from 'next';

export type UserLite = { id: string; email: string | null };
export type SB = any; // keep loose here (we’re using the service role client without generated types)

export const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// Pull the pseudo-auth from headers until you wire real auth
export function getUser(req: NextApiRequest): UserLite | null {
  const id = (req.headers['x-user-id'] as string) || '';
  const email = (req.headers['x-user-email'] as string) || '';
  return id ? { id, email } : null;
}

/** Ensure a row exists in `users` and a wallet in `wallets` for this user */
export async function ensureUserAndWallet(user: UserLite): Promise<void> {
  // upsert user
  const { error: uErr } = await sb.from('users').upsert({ id: user.id, email: user.email ?? null });
  if (uErr) throw uErr;

  // wallet present?
  const { data: rows, error: wSelErr } = await sb
    .from('wallets')
    .select('id')
    .eq('user_id', user.id)
    .limit(1);
  if (wSelErr) throw wSelErr;

  if (!rows || rows.length === 0) {
    const { error: wInsErr } = await sb
      .from('wallets')
      .insert({ user_id: user.id, balance_cents: 0, currency: 'usd' });
    if (wInsErr) throw wInsErr;
  }
}