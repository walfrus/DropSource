// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

type AnyObj = Record<string, any>;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  // --- 1) Verify signature (or allow bypass while debugging) -----------------
  const debugNoVerify = process.env.DEBUG_NO_VERIFY === '1';
  const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';

  const raw = await readRawBody(req); // keep raw body for HMAC + logging

  if (!debugNoVerify) {
    if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }
  }

  // --- 2) Parse and lightly normalize ---------------------------------------
  let body: AnyObj;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch (e: any) {
    await safeLog({ source: 'square', note: 'bad json', raw: raw.toString('utf8') });
    res.statusCode = 400; res.end('bad json'); return;
  }

  const eventType = String(body?.type || body?.event_type || '').toUpperCase();
  const obj = body?.data?.object ?? {};
  const payment: AnyObj | undefined =
    obj.payment ?? obj?.object ?? obj?.data?.object?.payment;

  // Square Online Checkout puts the ID here:
  const paymentLinkId =
    payment?.payment_link_id ??               // <- PRIMARY (Online Checkout)
    obj?.payment_link?.id ??                  // old guess (keep as fallback)
    obj?.payment_link_id ??                   // another fallback
    obj?.id ?? '';                            // very last resort

  // Keep a trail for debugging
  await safeLog({
    source: 'square',
    note: 'incoming',
    eventType,
    paymentLinkId,
    paymentStatus: payment?.status,
    snippet: JSON.stringify({ type: body?.type, keys: Object.keys(obj || {}) }).slice(0, 500),
  });

  // --- 3) We only credit on completed payments --------------------------------
  const isCompleted =
    eventType.includes('PAYMENT') &&
    (String(payment?.status || '').toUpperCase() === 'COMPLETED' ||
     eventType.includes('COMPLETED') ||
     eventType.includes('UPDATED')); // Square’s sandbox fires UPDATED on success

  if (!isCompleted) {
    res.statusCode = 200; res.end('ignored'); return;
  }

  if (!paymentLinkId) {
    await safeLog({ source: 'square', note: 'no payment_link_id', eventType, payment });
    res.statusCode = 200; res.end('no payment link id'); return;
  }

  // --- 4) Find the deposit row created in create-square ----------------------
  const { data: dep, error: depErr } = await sb
    .from('deposits')
    .select('*')
    .eq('provider_id', paymentLinkId)
    .single();

  if (depErr || !dep) {
    await safeLog({
      source: 'square',
      note: 'deposit not found for payment_link_id',
      paymentLinkId,
      depErr: depErr?.message,
    });
    res.statusCode = 200; res.end('no deposit'); return;
  }

  if (dep.status === 'paid') {
    // idempotent: we already credited
    res.statusCode = 200; res.end('already paid'); return;
  }

  // --- 5) Mark deposit paid, then credit wallet (idempotently) ----------------
  const upd = await sb.from('deposits')
    .update({ status: 'paid' })
    .eq('id', dep.id)
    .select('*')
    .single();

  if (upd.error) {
    await safeLog({ source: 'square', note: 'failed to mark paid', deposit_id: dep.id, err: upd.error.message });
    res.statusCode = 200; res.end('failed to mark'); return;
  }

  // increment wallet
  const w = await sb.from('wallets').select('id,balance_cents').eq('user_id', dep.user_id).single();
  const current = Number(w.data?.balance_cents || 0);
  const next = current + Number(dep.amount_cents || 0);

  const wUpd = await sb.from('wallets')
    .update({ balance_cents: next, updated_at: new Date().toISOString() })
    .eq('user_id', dep.user_id);

  if (wUpd.error) {
    await safeLog({ source: 'square', note: 'wallet update failed', deposit_id: dep.id, err: wUpd.error.message });
    res.statusCode = 200; res.end('wallet failed'); return;
  }

  await safeLog({
    source: 'square',
    note: 'wallet credited',
    user_id: dep.user_id,
    amount_cents: dep.amount_cents,
    deposit_id: dep.id,
    payment_link_id: paymentLinkId,
  });

  res.statusCode = 200;
  res.end('ok');
}

// minimal, never throws
async function safeLog(row: AnyObj) {
  try {
    await sb.from('webhook_logs').insert({
      source: String(row.source || 'square'),
      event_type: String(row.eventType || row.note || ''),
      payload: row,
    });
  } catch {}
}