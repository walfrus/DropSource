// api/deposits/create-square.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { sb } from '../../lib/db';
import { getUser } from '../../lib/auth';
import { ensureUserAndWallet } from '../_lib';

const SQ_BASE = 'https://connect.squareup.com/v2';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'no user' });

  const cents = Number(req.body?.amount_cents);
  if (!Number.isFinite(cents) || cents < 100) {
    return res.status(400).json({ error: 'min $1.00' });
  }

  await ensureUserAndWallet(user);

  const { data: dep, error } = await sb.from('deposits').insert({
    user_id: user.id,
    method: 'square',
    amount_cents: cents,
    status: 'pending',
  }).select('*').single();
  if (error) return res.status(400).json({ error: error.message });

  // Build an order with a reference_id so webhook can look it up
  const access = process.env.SQUARE_ACCESS_TOKEN!;
  const locationId = process.env.SQUARE_LOCATION_ID!;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${access}`,
    'Square-Version': '2024-07-17',
  };

  // Create an order with reference_id = deposit id
  const orderResp = await fetch(`${SQ_BASE}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      order: {
        location_id: locationId,
        reference_id: String(dep.id),
        line_items: [{
          name: 'DropSource Credits',
          quantity: '1',
          base_price_money: { amount: cents, currency: 'USD' },
        }],
      },
      idempotency_key: `${dep.id}-order`,
    }),
  });
  const order = await orderResp.json();
  if (!orderResp.ok) return res.status(400).json({ error: order?.errors?.[0]?.detail || 'square order failed' });

  // Create a payment link for the order (enables Cash App Pay on buyer side)
  const linkResp = await fetch(`${SQ_BASE}/online-checkout/payment-links`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: `${dep.id}-plink`,
      order_id: order.order.id,
      checkout_options: {
        redirect_url: `${process.env.PUBLIC_URL}/balance?ok=1`,
        ask_for_shipping_address: false,
      },
    }),
  });
  const link = await linkResp.json();
  if (!linkResp.ok) return res.status(400).json({ error: link?.errors?.[0]?.detail || 'square link failed' });

  await sb.from('deposits').update({
    provider_id: order.order.id,
  }).eq('id', dep.id);

  return res.json({ url: link.payment_link?.url });
}