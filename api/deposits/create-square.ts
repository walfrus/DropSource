// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { 
    res.statusCode = 405; 
    res.end(); 
    return; 
  }

  try {
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const raw = await readRawBody(req);

    // 🔹 Skip signature check for now while debugging
    let verified = false;
    try {
      const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
      verified = headerSig === expected;
    } catch {
      verified = false;
    }

    const body = JSON.parse(raw.toString('utf8'));
    const eventType = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};
    const plinkId = obj?.payment_link?.id || obj?.payment_link_id || obj?.id || '';

    // 🔹 Log everything to Supabase for debugging
    await sb.from('webhook_logs').insert({
      provider: 'square',
      event_type: eventType,
      provider_id: plinkId,
      payload: body,
      verified,
      created_at: new Date().toISOString(),
    });

    if (!plinkId) {
      res.statusCode = 200;
      res.end('no payment link id');
      return;
    }

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', plinkId).single();
    if (!dep) {
      res.statusCode = 200;
      res.end('no deposit found');
      return;
    }

    if (eventType.includes('PAYMENT') && eventType.includes('COMPLETED')) {
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      const { data: w } = await sb.from('wallets').select('id,balance_cents').eq('user_id', dep.user_id).single();
      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
    } else if (eventType.includes('CANCELED') || eventType.includes('FAILED')) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}