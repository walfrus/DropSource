// api/deposits/webhook-square.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { buffer } from 'micro';
import { sb } from '../../lib/db';

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  // Square sends signature in x-square-hmacsha256 (base64)
  const sig = (req.headers['x-square-hmacsha256'] as string) || '';
  const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY as string;
  if (!sig || !secret) return res.status(400).end();

  const raw = await buffer(req);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(raw)
    .digest('base64');

  if (sig !== expected) return res.status(401).json({ error: 'bad signature' });

  const event = JSON.parse(raw.toString('utf8'));
  const type = event?.type;

  if (type === 'payment.updated' || type === 'payment.created') {
    const payment = event?.data?.object?.payment;
    const status = payment?.status;
    const orderId = payment?.order_id as string | undefined;

    if (status === 'COMPLETED' && orderId) {
      const { data: dep } = await sb.from('deposits')
        .select('*')
        .eq('provider_id', orderId)
        .single();

      if (dep && dep.status !== 'completed') {
        await sb.rpc('increment_wallet',
          { p_user_id: dep.user_id, p_amount_cents: dep.amount_cents });

        await sb.from('deposits')
          .update({ status: 'completed' })
          .eq('id', dep.id);
      }
    }
  }

  res.json({ ok: true });
}