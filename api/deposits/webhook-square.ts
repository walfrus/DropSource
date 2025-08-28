// /api/deposits/webhook-square.ts
// Square webhook → verify signature (unless debug), find deposit by payment_link_id/order_id,
// mark it confirmed, and credit the user's wallet. Never 500 — always return 200 'ok'.

import { sb } from '../../lib/db.js';
import { readRawBody, ensureUserAndWallet } from '../../lib/smm.js';
import * as crypto from 'crypto';

export const config = { runtime: 'nodejs18.x' };

function sendJson(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function logWebhook(source: string, event: string, http_status: number, payload: any) {
  try {
    await sb.from('webhook_logs').insert({ source, event, http_status, payload });
  } catch {
    // swallow log errors
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    // Play nice with accidental GETs/monitors.
    res.statusCode = 200;
    res.end('ok');
    return;
  }

  const debugNoVerify = String(req.headers['x-debug-no-verify'] || '') === '1';
  const debugReturnError = String(req.headers['x-debug-return-error'] || '') === '1';

  try {
    const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const headerSig = String(req.headers['x-square-hmacsha256'] || '');
    const raw = await readRawBody(req);

    if (!debugNoVerify) {
      if (!secret || !headerSig) {
        await logWebhook('square', 'missing_signature', 400, { hasSecret: !!secret, hasHeader: !!headerSig });
        return sendJson(res, 400, { error: 'missing signature' });
      }
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      if (expected !== headerSig) {
        await logWebhook('square', 'bad_signature', 400, { expected, headerSig });
        return sendJson(res, 400, { error: 'bad signature' });
      }
    }

    const body = JSON.parse(raw.toString('utf8') || '{}');
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};
    const payment = obj?.payment || obj?.object?.payment || {};
    const paymentStatus = String(payment?.status || '').toUpperCase();
    const amountFromPayment = Number(payment?.amount_money?.amount || 0);

    // Square payloads may include either payment_link_id or nested payment_link.id
    const linkId = obj?.payment_link_id || obj?.payment_link?.id || payment?.payment_link_id || '';
    const orderId = payment?.order_id || obj?.order_id || '';
    const providerKey = String(linkId || orderId || '');

    if (!providerKey) {
      await logWebhook('square', 'no_provider_key', 200, { type, body });
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    // Find the pending deposit that created the Square Payment Link
    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerKey).single();
    if (!dep) {
      await logWebhook('square', 'deposit_not_found', 200, { providerKey, type });
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    // Only proceed on completed/approved payments
    const completed = type.includes('PAYMENT') && (paymentStatus === 'COMPLETED' || paymentStatus === 'APPROVED');
    if (!completed) {
      await logWebhook('square', 'ignored_event', 200, { type, paymentStatus, providerKey });
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    // Mark deposit as confirmed (avoid touching non-existent columns)
    const successStatus = (process.env.DEPOSIT_SUCCESS_STATUS || 'confirmed').toLowerCase();
    try {
      await sb.from('deposits').update({ status: successStatus }).eq('id', dep.id);
    } catch {
      // ignore schema mismatches silently
    }

    // Credit wallet
    const user_id = dep.user_id;
    const cents = Number(dep.amount_cents || amountFromPayment || 0);
    if (user_id && cents > 0) {
      // Ensure wallet exists, then atomically bump balance
      await ensureUserAndWallet(sb, { id: user_id, email: null });
      const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', user_id).single();
      const next = (Number(w?.balance_cents || 0) + cents);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', user_id);
    }

    await logWebhook('square', 'paid', 200, { dep_id: dep.id, providerKey, cents });
    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    await logWebhook('square', 'handler_error', 500, { error: String(e?.message || e) });
    if (debugReturnError) return sendJson(res, 200, { debug: 'handler_error', err: String(e?.message || e) });
    // Never bubble a 500 to Stripe/Square — just acknowledge
    res.statusCode = 200;
    res.end('ok');
  }
}