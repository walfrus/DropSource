// api/wallet/get.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { sb } from '../../lib/db';
import { getUser } from '../../lib/auth';
import { ensureUserAndWallet } from '../_lib'; // your helper

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: 'no user' });

    try {
      await ensureUserAndWallet(user);
    } catch (e: any) {
      console.error('ensureUserAndWallet failed:', e?.message);
      return res.status(500).json({ error: 'ensureUserAndWallet', message: e?.message });
    }

    try {
      const { data: w, error } = await sb.from('wallets')
        .select('*')
        .eq('user_id', user.id)
        .single();
      if (error) {
        console.error('select wallet failed:', error.message);
        return res.status(500).json({ error: 'select_wallet', message: error.message });
      }
      return res.json({ balance_cents: w?.balance_cents ?? 0, currency: w?.currency ?? 'usd' });
    } catch (e: any) {
      console.error('final read failed:', e?.message);
      return res.status(500).json({ error: 'final_read', message: e?.message });
    }
  } catch (e: any) {
    console.error('top-level crash:', e?.message);
    return res.status(500).json({ error: 'top', message: e?.message });
  }
}