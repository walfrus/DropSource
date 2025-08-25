// api/wallet/get.ts
import { sb } from '../../lib/db';
import { getUser } from '../../lib/auth';
import { ensureUserAndWallet } from '../_lib';

export default async function handler(req: any, res: any) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'no user' });

  await ensureUserAndWallet(user);

  const { data: w, error } = await sb.from('wallets').select('*').eq('user_id', user.id).single();
  if (error) return res.status(400).json({ error: error.message });

  res.json({ balance_cents: w?.balance_cents ?? 0, currency: w?.currency ?? 'usd' });
}