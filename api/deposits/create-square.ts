// api/deposits/create-square.ts
// Creates a Square Payment Link for a wallet deposit.
// Cash App Pay shows automatically on Square's hosted checkout (US accounts).

import { sb } from '../../lib/db';
import { getUser } from '../../lib/auth';
// your helper that ensures a user+wallet row exists
import { ensureUserAndWallet } from '../_lib';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'no user' });

  const cents = Number(req.body?.amount_cents);
  if (!Number.isFinite(cents) || cents < 100) {
    return res.status(400).json({ error: 'min $1.00' });
  }

  await ensureUserAndWallet(sb, user);

  // 1) create a pending deposit in Supabase
  const { data: dep, error } = await sb
    .from('deposits')
    .insert({
      user_id: user.id,
      method: 'square',
      amount_cents: cents,
      status: 'pending',
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // 2) create a Square Payment Link (Quick Pay)
  const r = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Square-Version': '2024-06-20',
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN!}`,
    },
    body: JSON.stringify({
      idempotency_key: dep.id, // unique per deposit
      quick_pay: {
        name: 'DropSource Credits',
        price_money: { amount: cents, currency: 'USD' },
        location_id: process.env.SQUARE_LOCATION_ID!,
        redirect_url: `${process.env.PUBLIC_URL}/balance?ok=1`,
        reference_id: dep.id, // we’ll use this in the webhook to find the deposit
      },
    }),
  });

  const json = await r.json();
  if (!r.ok) {
    return res.status(400).json({
      error: json?.errors?.[0]?.detail || 'square failed',
      debug: json,
    });
  }

  // 3) store provider link id (optional but nice)
  const linkId = json?.payment_link?.id || null;
  await sb.from('deposits').update({ provider_id: linkId }).eq('id', dep.id);

  // 4) send the customer to hosted checkout (Cash App Pay will appear there)
  const url = json?.payment_link?.url;
  return res.json({ url });
}