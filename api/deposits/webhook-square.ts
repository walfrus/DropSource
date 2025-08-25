// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

const SQUARE_VERSION = '2024-06-20';
const BASE =
  (process.env.SQUARE_ENV || '').toLowerCase() === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

async function sqGet(path: string) {
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      'Square-Version': SQUARE_VERSION,
      'Authorization': `Bearer ${(process.env.SQUARE_ACCESS_TOKEN || '').trim()}`,
      'Content-Type': 'application/json',
    }
  });
  const json = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(json?.errors?.[0]?.detail || `Square GET ${path} failed (${r.status})`);
  return json;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }

  try {
    // 1) Verify HMAC
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '').trim();
    if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }

    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }

    // 2) Parse and (optionally) log
    const body = JSON.parse(raw.toString('utf8'));
    try {
      await sb.from('webhook_logs').insert({
        provider: 'square',
        payload: body,
        created_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }

    // 3) Extract identifiers
    const type = String(body?.type || body?.event_type || '').toLowerCase();
    const obj = body?.data?.object || {};
    const payment = obj?.payment || obj;
    const order = obj?.order || obj;

    // Prefer order.id from payload; else get order_id via /v2/payments/{paymentId}
    let orderId: string = order?.id || payment?.order_id || '';
    if (!orderId && payment?.id) {
      const pay = await sqGet(`/v2/payments/${payment.id}`);
      orderId = pay?.payment?.order_id || '';
    }
    if (!orderId) { res.statusCode = 200; res.end('no order_id'); return; }

    // 4) Fetch order and read reference_id (we set this to deposits.id)
    const ord = await sqGet(`/v2/orders/${orderId}`);
    const referenceId = String(ord?.order?.reference_id || '').trim();
    if (!referenceId) { res.statusCode = 200; res.end('no reference_id'); return; }

    // 5) Load the deposit by its real ID
    const { data: dep } = await sb.from('deposits').select('*').eq('id', referenceId).single();
    if (!dep) { res.statusCode = 200; res.end('no deposit'); return; }

    // 6) Decide status transition
    const payStatus = String(payment?.status || '').toUpperCase();
    const isCompleted = type.includes('payment') && (payStatus === 'COMPLETED' || payStatus === 'APPROVED' || payStatus === 'CAPTURED');
    const isCanceled  = type.includes('payment') && (payStatus === 'CANCELED'  || payStatus === 'FAILED'   || payStatus === 'DECLINED');

    if (isCompleted) {
      if (dep.status !== 'paid') {
        await sb.from('deposits').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', dep.id);

        const { data: w } = await sb.from('wallets')
          .select('balance_cents')
          .eq('user_id', dep.user_id)
          .single();

        const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
        await sb.from('wallets').update({ balance_cents: next, updated_at: new Date().toISOString() }).eq('user_id', dep.user_id);
      }
    } else if (isCanceled) {
      if (dep.status !== 'canceled') {
        await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      }
    } else {
      res.statusCode = 200; res.end('ignored'); return;
    }

    try {
      await sb.from('webhook_logs').insert({
        provider: 'square',
        note: `handled ${type} for order ${orderId} → deposit ${referenceId}`,
        created_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    try {
      await sb.from('webhook_logs').insert({
        provider: 'square',
        error: String(e?.message || e),
        created_at: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}