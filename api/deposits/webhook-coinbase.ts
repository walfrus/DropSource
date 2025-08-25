// api/deposits/webhook-coinbase.ts
import crypto from 'crypto';
import { sb } from '../../lib/db';

export const config = { api: { bodyParser: false } };

function readRaw(req: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer)=>chunks.push(c));
    req.on('end', ()=>resolve(Buffer.concat(chunks)));
  });
}

export default async function handler(req: any, res: any) {
  const raw = await readRaw(req);
  const sig = req.headers['x-cc-webhook-signature'] as string;
  const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET!;
  const hmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');

  if (hmac !== sig) return res.status(400).send('bad sig');

  const evt = JSON.parse(raw.toString());
  const type = evt.event?.type;           // e.g. 'charge:confirmed'
  const data = evt.event?.data;
  const depositId = data?.metadata?.depositId;

  if ((type === 'charge:confirmed' || type === 'charge:resolved') && depositId) {
    const { data: dep } = await sb.from('deposits').select('*').eq('id', depositId).single();
    if (dep && dep.status === 'pending') {
      await sb.rpc('perform_wallet_credit', {
        p_user_id: dep.user_id,
        p_amount_cents: dep.amount_cents,
        p_ref: data?.id || 'coinbase',
        p_meta: { provider: 'coinbase', type }
      });
      await sb.from('deposits').update({ status: 'confirmed' }).eq('id', depositId);
    }
  }

  res.json({ ok: true });
}