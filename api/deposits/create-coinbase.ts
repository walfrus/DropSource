// api/deposits/create-coinbase.ts
import { sb } from '../../lib/db';
import { getUser } from '../../lib/auth';
import { ensureUserAndWallet } from '../_lib';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'no user' });

  const cents = Number(req.body?.amount_cents);
  if (!cents || cents < 100) return res.status(400).json({ error: 'min $1.00' });
  const amountUsd = (cents / 100).toFixed(2);

  await ensureUserAndWallet(user);

  // create pending deposit
  const { data: dep, error } = await sb.from('deposits').insert({
    user_id: user.id, method: 'coinbase', amount_cents: cents, status: 'pending'
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // create Coinbase Commerce charge
  const r = await fetch('https://api.commerce.coinbase.com/charges', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CC-Api-Key': process.env.COINBASE_COMMERCE_API_KEY!,
      'X-CC-Version': '2018-03-22'
    },
    body: JSON.stringify({
      name: 'DropSource Credits',
      pricing_type: 'fixed_price',
      local_price: { amount: amountUsd, currency: 'USD' },
      metadata: { userId: user.id, depositId: dep.id },
      redirect_url: `${process.env.PUBLIC_URL}/balance?ok=1`,
      cancel_url: `${process.env.PUBLIC_URL}/balance?canceled=1`
    })
  });
  const json = await r.json();
  if (!r.ok) return res.status(400).json({ error: json?.error?.message || 'coinbase failed' });

  await sb.from('deposits').update({ provider_id: json.data?.id || null }).eq('id', dep.id);
  return res.json({ url: json.data?.hosted_url });
}