import { sb } from '../../lib/db.js';
import { getUser } from '../../lib/auth.js';
import { ensureUserAndWallet } from '../../lib/smm.js';

export default async function handler(req: any, res: any) {
  const user = getUser(req);
  if (!user) { res.statusCode = 401; res.end(JSON.stringify({ error: 'no user' })); return; }

  await ensureUserAndWallet(sb, user);
  const { data: w, error } = await sb.from('wallets').select('*').eq('user_id', user.id).single();
  if (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); return; }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ balance_cents: w?.balance_cents ?? 0, currency: w?.currency ?? 'usd' }));
}