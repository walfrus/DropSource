// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

function sqBase() {
  return (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
}

async function fetchPaymentLinkIdFromSquare(paymentId: string): Promise<string | null> {
  if (!paymentId) return null;
  const token = process.env.SQUARE_ACCESS_TOKEN || '';
  if (!token) return null;

  const r = await fetch(`${sqBase()}/v2/payments/${paymentId}`, {
    headers: {
      'Square-Version': '2024-06-20',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!r.ok) return null;
  const json = await r.json().catch(() => null);
  const linkId =
    json?.payment?.payment_link?.id ||
    json?.payment?.payment_link_id ||
    null;

  return linkId || null;
}

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
    const obj = body?.data?.object ?? {};
    const payment = obj?.payment ?? {};
    const status = String(payment?.status || '').toUpperCase();
    const paymentId = payment?.id || '';

    // Try to get payment_link_id from the webhook first
    let paymentLinkId: string | null =
      payment?.payment_link?.id ||
      payment?.payment_link_id ||
      obj?.payment_link?.id ||
      obj?.payment_link_id ||
      null;

    // Fallback: retrieve payment from Square to fetch payment_link_id
    if (!paymentLinkId && paymentId) {
      paymentLinkId = await fetchPaymentLinkIdFromSquare(paymentId);
    }

    // Log what we saw (no .catch — TS-safe)
    await sb.from('webhook_logs').insert({
      src: 'square',
      payload: {
        event_type: body?.type,
        status,
        payment_id: paymentId,
        payment_link_id: paymentLinkId
      },
      note: 'square webhook in'
    });

    if (!paymentLinkId) { res.statusCode = 200; res.end('no payment_link_id'); return; }

    // We saved provider_id = payment_link.id at create-square
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .select('*')
      .eq('provider_id', paymentLinkId)
      .single();

    if (depErr || !dep) {
      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { payment_link_id: paymentLinkId, status },
        note: 'no matching deposit'
      });
      res.statusCode = 200; res.end('no deposit'); return;
    }

    if (status === 'COMPLETED') {
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      const { data: w } = await sb
        .from('wallets')
        .select('id,balance_cents')
        .eq('user_id', dep.user_id)
        .single();

      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);

      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { deposit_id: dep.id, credited: dep.amount_cents },
        note: 'credited'
      });
    } else if (status === 'CANCELED' || status === 'FAILED') {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { deposit_id: dep.id, status },
        note: 'canceled/failed'
      });
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    try {
      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { error: String(e?.message || e) },
        note: 'exception'
      });
    } catch {}
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}