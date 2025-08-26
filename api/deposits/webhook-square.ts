// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

type AnyObj = Record<string, any>;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  // --- signature (can bypass while debugging) ---
  const debugNoVerify = process.env.DEBUG_NO_VERIFY === '1';
  const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';

  const raw = await readRawBody(req);

  if (!debugNoVerify) {
    if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }
  }

  // --- parse & normalize ---
  let body: AnyObj;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { await log({ source:'square', note:'bad json', raw: raw.toString('utf8') }); res.statusCode=400; res.end('bad json'); return; }

  const eventType = String(body?.type || body?.event_type || '').toUpperCase();
  const obj = body?.data?.object ?? {};
  const payment: AnyObj | undefined =
    obj.payment ?? obj?.object ?? obj?.data?.object?.payment;

  // try every known home of the link id
  const paymentLinkId =
    payment?.payment_link_id ??
    obj?.payment_link?.id ??
    obj?.payment_link_id ??
    obj?.id ?? '';

  // payment amount if present (square uses integer cents)
  const paymentAmountCents =
    Number(payment?.amount_money?.amount ?? payment?.total_money?.amount ?? 0) || null;

  const status = String(payment?.status || '').toUpperCase();
  const isFailure = status === 'FAILED' || status === 'CANCELED';

  // sandbox often fires PAYMENT.UPDATED; consider anything non-failed as ok
  const looksPaid =
    eventType.startsWith('PAYMENT') && !isFailure;

  await log({
    source: 'square',
    note: 'incoming',
    eventType,
    status,
    paymentLinkId,
    paymentAmountCents,
    sampleKeys: Object.keys(obj || {}),
  });

  if (!looksPaid) { res.statusCode = 200; res.end('ignored'); return; }
  if (!paymentLinkId) { await log({ source:'square', note:'no payment_link_id' }); res.statusCode=200; res.end('no id'); return; }

  // --- find the deposit we created in create-square ---
  const { data: dep, error: depErr } = await sb
    .from('deposits')
    .select('*')
    .eq('provider_id', paymentLinkId)
    .single();

  if (depErr || !dep) {
    await log({ source:'square', note:'deposit not found', paymentLinkId, depErr: depErr?.message });
    res.statusCode = 200; res.end('no deposit'); return;
  }

  if (dep.status === 'paid') { res.statusCode = 200; res.end('already paid'); return; }

  // sanity: if Square gave an amount, ensure it’s >= our deposit
  if (paymentAmountCents && paymentAmountCents < Number(dep.amount_cents || 0)) {
    await log({ source:'square', note:'amount smaller than deposit', paymentAmountCents, deposit_amount: dep.amount_cents });
    // still ignore, don’t credit
    res.statusCode = 200; res.end('amount mismatch'); return;
  }

  // mark paid
  const up = await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
  if (up.error) { await log({ source:'square', note:'failed mark paid', err: up.error.message }); res.statusCode=200; res.end('mark fail'); return; }

  // credit wallet
  const w = await sb.from('wallets').select('id,balance_cents').eq('user_id', dep.user_id).single();
  const cur = Number(w.data?.balance_cents || 0);
  const next = cur + Number(dep.amount_cents || 0);

  const wup = await sb.from('wallets')
    .update({ balance_cents: next, updated_at: new Date().toISOString() })
    .eq('user_id', dep.user_id);

  if (wup.error) { await log({ source:'square', note:'wallet update failed', err: wup.error.message }); res.statusCode=200; res.end('wallet fail'); return; }

  await log({ source:'square', note:'wallet credited', user_id: dep.user_id, amount_cents: dep.amount_cents, payment_link_id: paymentLinkId });
  res.statusCode = 200; res.end('ok');
}

async function log(row: AnyObj) {
  try { await sb.from('webhook_logs').insert({ source: String(row.source||'square'), event_type: String(row.note||''), payload: row }); }
  catch {}
}