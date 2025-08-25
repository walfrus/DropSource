// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

type SquareEvent = {
  type?: string; // e.g. "payment.updated"
  data?: {
    object?: any;
  };
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('method not allowed');
    return;
  }

  try {
    // ── 1) Verify signature ─────────────────────────────────────────────────────
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    if (!headerSig || !key) {
      res.statusCode = 400;
      res.end('missing signature');
      return;
    }

    const raw = await readRawBody(req); // Buffer
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) {
      res.statusCode = 400;
      res.end('bad signature');
      return;
    }

    // ── 2) Parse body & do a best-effort log (ignore log errors) ────────────────
    const body = JSON.parse(raw.toString('utf8')) as SquareEvent;

    {
      const { error: _logErr } = await sb.from('webhook_logs').insert({
        provider: 'square',
        payload: body,
        created_at: new Date().toISOString(),
      });
      // ignore _logErr
    }

    // ── 3) Extract identifiers we might match on ────────────────────────────────
    const type = String(body?.type || '').toLowerCase();

    // Square sends different shapes per topic; for "payment.*" the
    // object is a Payment. For "order.*" it's an Order. We try to
    // pluck a payment_link id if present (Order has it), otherwise
    // fall back to the payment id.
    const obj = body?.data?.object || {};
    // If this is an Order event it may be at obj.order
    const order = obj.order || obj;
    const payment = obj.payment || obj;

    // Try common places the payment-link id can live; if we can’t find it,
    // we’ll try with the payment id as a fallback match.
    const paymentLinkId: string =
      order?.payment_link?.id ||
      order?.payment_link_id ||
      payment?.payment_link?.id ||
      payment?.payment_link_id ||
      '';

    const paymentId: string = payment?.id || '';

    // ── 4) Find the related pending deposit we created at checkout ─────────────
    // We store provider_id = payment_link.id when creating the link.
    // First try by paymentLinkId, else try by the payment id (fallback).
    let dep: any = null;

    if (paymentLinkId) {
      const { data } = await sb
        .from('deposits')
        .select('*')
        .eq('provider_id', paymentLinkId)
        .single();
      dep = data || null;
    }

    if (!dep && paymentId) {
      const { data } = await sb
        .from('deposits')
        .select('*')
        .eq('provider_id', paymentId)
        .single();
      dep = data || null;
    }

    if (!dep) {
      // Nothing to do; keep the webhook fast.
      res.statusCode = 200;
      res.end('no matching deposit');
      return;
    }

    // ── 5) Decide status transitions ────────────────────────────────────────────
    // Treat a completed payment as "paid"; canceled/failed as "canceled".
    const payStatus = String(payment?.status || '').toUpperCase();

    const isCompleted =
      type.includes('payment') &&
      (payStatus === 'COMPLETED' || payStatus === 'APPROVED' || payStatus === 'CAPTURED');

    const isCanceled =
      type.includes('payment') &&
      (payStatus === 'CANCELED' || payStatus === 'FAILED' || payStatus === 'DECLINED');

    if (isCompleted) {
      // Mark deposit paid
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      // Credit wallet
      const { data: w } = await sb
        .from('wallets')
        .select('id,balance_cents')
        .eq('user_id', dep.user_id)
        .single();

      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
    } else if (isCanceled) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    } else {
      // Not a final state we care about; acknowledge.
      res.statusCode = 200;
      res.end('ignored');
      return;
    }

    // Optional: log success (ignore log errors)
    {
      const { error: _logErr2 } = await sb.from('webhook_logs').insert({
        provider: 'square',
        note: `handled ${type} for deposit ${dep.id}`,
        created_at: new Date().toISOString(),
      });
      // ignore _logErr2
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    // Try to log the error (ignore failures)
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