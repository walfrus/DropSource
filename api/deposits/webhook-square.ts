// /api/deposits/webhook-square.ts
import { sb } from '../../lib/db.js';
import { readRawBody, ensureUserAndWallet } from '../../lib/smm.js';
import * as crypto from 'crypto';

export const config = { runtime: 'nodejs18.x' };

function sendText(res: any, code: number, text: string) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}
function sendJson(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
async function logWebhook(event: string, http_status: number, payload: any) {
  try {
    await sb.from('webhook_logs').insert({ source: 'square', event, http_status, payload });
  } catch {
    // ignore log errors
  }
}

export default async function handler(req: any, res: any) {
  // Square webhooks are POST. For anything else, just 200 "ok" so monitors don't fail.
  if (req.method !== 'POST') return sendText(res, 200, 'ok');

  const debugNoVerify = String(req.headers['x-debug-no-verify'] || '') === '1';
  const debugReturnError = String(req.headers['x-debug-return-error'] || '') === '1';

  try {
    // 1) Verify signature unless explicitly disabled for local tests
    const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const headerSig = String(req.headers['x-square-hmacsha256'] || '');
    const raw = await readRawBody(req);

    if (!debugNoVerify) {
      if (!secret || !headerSig) {
        await logWebhook('missing_signature', 400, { hasSecret: !!secret, hasHeader: !!headerSig });
        return sendJson(res, 400, { error: 'missing signature' });
      }
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      if (expected !== headerSig) {
        await logWebhook('bad_signature', 400, { expected, headerSig });
        return sendJson(res, 400, { error: 'bad signature' });
      }
    }

    // 2) Parse body and extract identifiers
    const body = JSON.parse(raw.toString('utf8') || '{}');
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};
    const payment = obj?.payment || obj?.object?.payment || {};
    const paymentStatus = String(payment?.status || '').toUpperCase();
    const amountFromPayment = Number(payment?.amount_money?.amount || 0);

    const linkId = obj?.payment_link_id || obj?.payment_link?.id || payment?.payment_link_id || '';
    const orderId = payment?.order_id || obj?.order_id || '';
    const providerKey = String(linkId || orderId || '');

    if (!providerKey) {
      await logWebhook('no_provider_key', 200, { type, body });
      return sendText(res, 200, 'ok');
    }

    // 3) Find the pending deposit that created the Square Payment Link
    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerKey).single();
    if (!dep) {
      await logWebhook('deposit_not_found', 200, { providerKey, type });
      return sendText(res, 200, 'ok');
    }

    // 4) Only proceed on completed/approved payments
    const completed = type.includes('PAYMENT') && (paymentStatus === 'COMPLETED' || paymentStatus === 'APPROVED');
    if (!completed) {
      await logWebhook('ignored_event', 200, { type, paymentStatus, providerKey });
      return sendText(res, 200, 'ok');
    }

    // 5) Mark deposit as confirmed (status column only — schema-safe)
    const successStatus = (process.env.DEPOSIT_SUCCESS_STATUS || 'confirmed').toLowerCase();
    try {
      await sb.from('deposits').update({ status: successStatus }).eq('id', dep.id);
    } catch {
      // ignore schema mismatches silently
    }

    // 6) Credit wallet using the deposit amount (fallback to payment amount)
    const user_id = dep.user_id;
    const cents = Number(dep.amount_cents || amountFromPayment || 0);
    if (user_id && cents > 0) {
      await ensureUserAndWallet(sb, { id: user_id, email: null });
      const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', user_id).single();
      const next = (Number(w?.balance_cents || 0) + cents);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', user_id);
    }

    await logWebhook('paid', 200, { dep_id: dep.id, providerKey, cents });
    return sendText(res, 200, 'ok');
  } catch (e: any) {
    await logWebhook('handler_error', 200, { error: String(e?.message || e) });
    // Never bubble a 500 to Square — acknowledge and optionally echo for debug
    if (String(req.headers['x-debug-return-error'] || '') === '1') {
      return sendJson(res, 200, { debug: 'handler_error', err: String(e?.message || e) });
    }
    return sendText(res, 200, 'ok');
  }
}