// /api/deposits/webhook-coinbase.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

async function log(note: string, payload: any) {
  try {
    await sb.from('webhook_logs').insert({ src: 'coinbase', note, payload });
  } catch { /* ignore logging errors */ }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const sig = req.headers['x-cc-webhook-signature'] as string | undefined;
    const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '';
    if (!sig || !secret) { res.statusCode = 400; res.end('missing signature'); return; }

    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (sig !== expected) { await log('bad signature', { sig }); res.statusCode = 400; res.end('bad signature'); return; }

    const body = JSON.parse(raw.toString('utf8'));
    const type = String(body?.event?.type || '');
    const providerId = String(body?.event?.data?.id || '');

    await log('coinbase webhook in', { type, providerId });

    if (!providerId) { await log('no provider id', body); res.statusCode = 200; res.end('ok'); return; }

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerId).single();
    if (!dep) { await log('no deposit match', { providerId }); res.statusCode = 200; res.end('ok'); return; }

    if (type === 'charge:confirmed' || type === 'charge:resolved') {
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      await sb.rpc('increment_wallet', { p_user_id: dep.user_id, p_delta_cents: dep.amount_cents });
      await log('credited via rpc', { deposit_id: dep.id, user_id: dep.user_id, cents: dep.amount_cents });
    } else if (type === 'charge:failed') {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await log('marked canceled', { deposit_id: dep.id });
    } else {
      await log('ignored event', { type });
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    await log('exception', { message: String(e?.message || e) });
    res.statusCode = 200;            // 200 so Coinbase doesn’t retry forever
    res.end('ok');
  }
}