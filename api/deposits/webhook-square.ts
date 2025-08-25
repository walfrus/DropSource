// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

async function log(note: string, payload: any) {
  try {
    await sb.from('webhook_logs').insert({ src: 'square', note, payload });
  } catch { /* ignore logging errors */ }
}

function sqBase() {
  return (process.env.SQUARE_ENV === 'sandbox')
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const headerSig = String(req.headers['x-square-hmacsha256'] || '');
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }

    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) { await log('bad signature', { headerSig }); res.statusCode = 400; res.end('bad signature'); return; }

    const body = JSON.parse(raw.toString('utf8'));
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    await log('square webhook in', { type });

    // Try to extract a payment link id from the payload.
    let paymentLinkId: string =
      body?.data?.object?.payment_link?.id
      || body?.data?.object?.payment?.payment_link?.id
      || body?.data?.object?.payment?.order?.payment_link_id
      || '';

    // If missing, fetch payment details using payment id (common in sandbox).
    if (!paymentLinkId) {
      const paymentId: string =
        body?.data?.object?.payment?.id
        || body?.data?.id
        || '';

      if (paymentId) {
        try {
          const r = await fetch(`${sqBase()}/v2/payments/${paymentId}`, {
            headers: {
              'Square-Version': '2024-06-20',
              'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ''}`,
            }
          });
          const j = await r.json();
          paymentLinkId = j?.payment?.payment_link?.id
                        || j?.payment?.order?.payment_link_id
                        || '';
          await log('fetch payment detail', { paymentId, paymentLinkId, ok: r.ok });
        } catch (e: any) {
          await log('fetch payment detail failed', { message: String(e?.message || e) });
        }
      }
    }

    if (!paymentLinkId) { await log('no paymentLinkId', body); res.statusCode = 200; res.end('ok'); return; }

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', paymentLinkId).single();
    if (!dep) { await log('no deposit match', { paymentLinkId }); res.statusCode = 200; res.end('ok'); return; }

    // Decide "paid" from the payment status if present.
    const status = String(body?.data?.object?.payment?.status || '').toUpperCase();
    const isCompleted = status === 'COMPLETED' || type.includes('PAYMENT.UPDATED');

    if (isCompleted) {
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      await sb.rpc('increment_wallet', { p_user_id: dep.user_id, p_delta_cents: dep.amount_cents });
      await log('credited via rpc', { deposit_id: dep.id, user_id: dep.user_id, cents: dep.amount_cents });
    } else if (status === 'CANCELED' || status === 'FAILED' || type.includes('CANCELED')) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await log('marked canceled', { deposit_id: dep.id, status });
    } else {
      await log('ignored event', { status, type });
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    await log('exception', { message: String(e?.message || e) });
    res.statusCode = 200;            // 200 so Square doesn’t keep retrying indefinitely
    res.end('ok');
  }
}