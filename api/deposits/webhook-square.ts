// /api/deposits/webhook-square.ts
import { readRawBody } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';
import * as crypto from 'node:crypto';

export const config = { runtime: 'nodejs18.x' };

function json(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const skipVerify = String(req.headers['x-debug-no-verify'] || '') === '1';
    const raw = await readRawBody(req);

    if (!skipVerify) {
      const headerSig = String(req.headers['x-square-hmacsha256'] || '');
      const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
      if (!headerSig || !key) return json(res, 400, { error: 'missing signature' });
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
      if (headerSig !== expected) return json(res, 400, { error: 'bad signature' });
    }

    const body = JSON.parse(raw.toString('utf8') || '{}');
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || body?.data || {};

    // Extract payment link id from a few possible shapes
    const paymentLinkId =
      obj?.payment_link?.id ||
      obj?.payment_link_id ||
      obj?.id ||
      body?.data?.id ||
      '';

    const payment = obj?.payment || obj?.object?.payment || {};
    const status = String(payment?.status || '').toUpperCase();

    if (!paymentLinkId) return json(res, 200, { ok: true, note: 'no payment_link id' });

    // Find matching deposit by provider_id (we saved the Square payment_link id there)
    const { data: dep, error: depErr } = await sb.from('deposits').select('*').eq('provider_id', paymentLinkId).single();
    if (depErr || !dep) return json(res, 200, { ok: true, note: 'no deposit', payment_link_id: paymentLinkId });

    const SUCCESS_STATUS = String(process.env.DEPOSIT_SUCCESS_STATUS || 'completed').toLowerCase();

    const isCompleted = status === 'COMPLETED' || type.includes('COMPLETED') || type.startsWith('PAYMENT.');
    if (isCompleted) {
      // mark deposit as successful
      const up1 = await sb.from('deposits').update({ status: SUCCESS_STATUS }).eq('id', dep.id).select('id').single();
      if (up1.error) return json(res, 200, { debug: 'mark_paid_failed', err: up1.error.message, dep: { id: dep.id, status: dep.status, provider_id: dep.provider_id } });

      // credit wallet
      const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      const up2 = await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
      if (up2.error) return json(res, 200, { debug: 'wallet_update_failed', err: up2.error.message });

      return json(res, 200, { ok: true });
    } else {
      // mark canceled/failed if we can detect it; otherwise ignore
      if (status === 'CANCELED' || type.includes('CANCELED') || type.includes('FAILED')) {
        await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      }
      return json(res, 200, { ok: true, note: 'ignored status', status });
    }

  } catch (e: any) {
    const dbg = String(req.headers['x-debug-return-error'] || '') === '1';
    if (dbg) return json(res, 200, { debug: 'handler_error', err: String(e?.message || e) });
    res.statusCode = 200; res.end('ok');
  }
}