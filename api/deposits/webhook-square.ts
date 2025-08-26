// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

// Helper: safest way to pull a value out of lots of possible shapes
function pick<T = any>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v as T;
  return undefined;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  let note = '';
  try {
    // ── 1) Verify signature (unless DEBUG_NO_VERIFY=1)
    const debugNoVerify = process.env.DEBUG_NO_VERIFY === '1';
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const raw = await readRawBody(req);

    if (!debugNoVerify) {
      if (!headerSig || !key) {
        res.statusCode = 400; res.end('missing signature'); return;
      }
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
      if (headerSig !== expected) {
        // log and bail early
        await sb.from('webhook_logs').insert({
          source: 'square',
          event_type: 'sig_mismatch',
          status: '400',
          body: {},
          note: `headerSig: ${headerSig.slice(0,8)}..., expected: ${expected.slice(0,8)}...`
        });
        res.statusCode = 400; res.end('bad signature'); return;
      }
    } else {
      note = 'DEBUG_NO_VERIFY=1';
      await sb.from('webhook_logs').insert({
        source: 'square',
        event_type: 'debug_no_verify',
        status: '200',
        body: {},
        note
      });
    }

    // ── 2) Parse JSON body
    const body = JSON.parse(raw.toString('utf8'));

    const type = String(
      pick(
        body?.type,
        body?.event_type
      ) || ''
    ).toUpperCase();

    const obj = body?.data?.object || body?.data || {};

    // Square sends the payment link id in a few places depending on event:
    const paymentLinkId =
      pick(
        obj?.payment_link?.id,
        obj?.payment_link_id,
        obj?.payment?.payment_link_id,   // <-- YOUR TEST PAYLOAD USED THIS
        obj?.payment?.link_id,
        obj?.id
      ) || '';

    const paymentStatus = String(
      pick(
        obj?.payment?.status,
        obj?.status
      ) || ''
    ).toUpperCase();

    // ── 3) Write a webhook log row (best-effort)
    await sb.from('webhook_logs').insert({
      source: 'square',
      event_type: type,
      status: 'received',
      body,
      note: `plid=${paymentLinkId || '∅'} status=${paymentStatus || '∅'} ${note}`
    });

    if (!paymentLinkId) {
      res.statusCode = 200; res.end('no payment link id'); return;
    }

    // ── 4) Find the matching deposit we created when we made the checkout link
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .select('*')
      .eq('provider_id', paymentLinkId)
      .single();

    if (depErr || !dep) {
      await sb.from('webhook_logs').insert({
        source: 'square',
        event_type: type,
        status: 'no_deposit',
        body,
        note: `plid=${paymentLinkId}`
      });
      res.statusCode = 200; res.end('no deposit'); return;
    }

    // ── 5) Decide if this means "paid" or "canceled/failed"
    const isCompleted =
      paymentStatus === 'COMPLETED' ||
      (type.includes('PAYMENT') && type.includes('COMPLETED')) ||
      (type.includes('ORDER') && type.includes('UPDATED') && paymentStatus === 'COMPLETED');

    const isCanceled =
      paymentStatus === 'CANCELED' || paymentStatus === 'FAILED' ||
      type.includes('CANCELED') || type.includes('FAILED');

    if (isCompleted) {
      // Mark row paid (idempotent)
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      // Credit wallet (prefer RPC if you created it; else fallback to direct update)
      const delta = Number(dep.amount_cents || 0) || 0;

      // Try RPC first (ignore failure, we’ll fallback)
      const rpc = await sb.rpc('increment_wallet', { p_user_id: dep.user_id, p_delta_cents: delta }).select().maybeSingle();
      if ((rpc as any)?.error) {
        // Fallback direct update
        const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
        const next = (w?.balance_cents || 0) + delta;
        await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
      }

      await sb.from('webhook_logs').insert({
        source: 'square',
        event_type: type,
        status: 'paid',
        body,
        note: `dep=${dep.id} +${delta}c`
      });

      res.statusCode = 200; res.end('ok');
      return;
    }

    if (isCanceled) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await sb.from('webhook_logs').insert({
        source: 'square',
        event_type: type,
        status: 'canceled',
        body,
        note: `dep=${dep.id}`
      });
      res.statusCode = 200; res.end('ok');
      return;
    }

    // Unknown / not actionable → ack
    await sb.from('webhook_logs').insert({
      source: 'square',
      event_type: type,
      status: 'ignored',
      body,
      note: `plid=${paymentLinkId} status=${paymentStatus}`
    });
    res.statusCode = 200; res.end('ok');
  } catch (e: any) {
    try {
      await sb.from('webhook_logs').insert({
        source: 'square',
        event_type: 'exception',
        status: '500',
        body: {},
        note: String(e?.message || e)
      });
    } catch { /* ignore */ }
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}