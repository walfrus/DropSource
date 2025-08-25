// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

// ...rest unchanged...

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }

    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }

    const body = JSON.parse(raw.toString('utf8'));
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};
    const plinkId = obj?.payment_link?.id || obj?.payment_link_id || obj?.id || '';

    if (!plinkId) { res.statusCode = 200; res.end('no payment link id'); return; }

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', plinkId).single();
    if (!dep) { res.statusCode = 200; res.end('no deposit'); return; }

    if (type.includes('PAYMENT') && type.includes('COMPLETED')) {
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      const { data: w } = await sb.from('wallets').select('id,balance_cents').eq('user_id', dep.user_id).single();
      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
    } else if (type.includes('CANCELED') || type.includes('FAILED')) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}