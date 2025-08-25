// api/deposits/webhook-coinbase.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { buffer } from 'micro';
import { sb } from '../../lib/db';

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = (req.headers['x-cc-webhook-signature'] as string) || '';
  const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET as string;
  if (!sig || !secret) return res.status(400).end();

  const raw = (await buffer(req)).toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (sig !== expected) return res.status(401).end();

  const evt = JSON.parse(raw);
  const type = evt?.event?.type;
  const charge = evt?.event?.data;

  // We stored provider_id (charge.id) on the deposit
  const providerId = charge?.id as string | undefined;

  if (type === 'charge:confirmed' || type === 'charge:resolved') {
    if (providerId) {
      const { data: dep } = await sb
        .from('deposits').select('*')
        .eq('provider_id', providerId).single();

      if (dep && dep.status !== 'completed') {
        // credit wallet
        await sb.rpc('increment_wallet',
          { p_user_id: dep.user_id, p_amount_cents: dep.amount_cents });

        // mark complete
        await sb.from('deposits')
          .update({ status: 'completed' })
          .eq('id', dep.id);
      }
    }
  }

  res.json({ ok: true });
}