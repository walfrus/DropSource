// /api/deposits/webhook-coinbase.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

// ...rest unchanged...
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const sig = req.headers['x-cc-webhook-signature'] as string | undefined;
    const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '';
    if (!sig || !secret) { res.statusCode = 400; res.end('missing signature'); return; }

    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (sig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }

    const body = JSON.parse(raw.toString('utf8'));
    const type = body?.event?.type || '';
    const providerId = body?.event?.data?.id || '';

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerId).single();
    if (!dep) { res.statusCode = 200; res.end('no deposit'); return; }

    if (type === 'charge:confirmed' || type === 'charge:resolved') {
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      const { data: w } = await sb.from('wallets').select('id,balance_cents').eq('user_id', dep.user_id).single();
      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
    } else if (type === 'charge:failed') {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}