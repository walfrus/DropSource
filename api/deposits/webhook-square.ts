// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

/**
 * Safe log helper: never throws, never blocks the response.
 * Writes to console (Vercel logs). If you also want a DB log,
 * you can uncomment the Supabase insert — it's wrapped so it
 * won't break the webhook on failure.
 */
async function safeLog(kind: string, payload: any) {
  try {
    console.log(`[square:${kind}]`, JSON.stringify(payload, null, 2));

    // Optional DB log (make sure your table/columns exist)
    // await sb.from('webhook_logs').insert({
    //   source: 'square',
    //   kind,
    //   payload,
    // });
  } catch (_e) {
    // swallow
  }
}

/**
 * Extract a payment_link_id from a variety of possible payload shapes.
 * Square sends different shapes depending on product/event.
 */
function extractPaymentLinkId(body: any): string | null {
  const d = body?.data;
  const obj = d?.object ?? d?.data ?? body?.object ?? {};

  // Try several plausible places
  const candidates: Array<any> = [
    obj?.payment_link?.id,
    obj?.payment_link_id,
    obj?.payment?.payment_link_id,
    obj?.checkout?.payment_link?.id,
    obj?.checkout?.payment_link_id,
    obj?.payment_link?.payment_link_id, // (seen in some samples)
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }

  // Some Square events only include a payment id/order id.
  // If you later want to resolve payment_id -> payment_link_id,
  // you can call Square Payments API here. For now, just log.
  return null;
}

/**
 * Extract a normalized "status" for the payment if present.
 */
function extractPaymentStatus(body: any): string | null {
  const status =
    body?.data?.object?.payment?.status ??
    body?.data?.object?.status ??
    body?.data?.object?.payment_link?.status ??
    null;

  return typeof status === 'string' ? status.toUpperCase() : null;
}

/**
 * Normalize the event "type"
 */
function extractEventType(body: any): string {
  const t = String(body?.type || body?.event_type || '').toUpperCase();
  return t;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }

  try {
    const raw = await readRawBody(req);
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const noVerify = process.env.DEBUG_NO_VERIFY === '1';

    // HMAC check (unless disabled for debugging)
    if (!noVerify) {
      if (!headerSig || !key) {
        await safeLog('bad_signature_header', { headerSigPresent: !!headerSig, keyPresent: !!key });
        res.statusCode = 200; // don't retry, but log the miss
        res.end('missing signature');
        return;
      }
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
      if (headerSig !== expected) {
        await safeLog('sig_mismatch', { headerSig, expected });
        res.statusCode = 200;
        res.end('bad signature');
        return;
      }
    } else {
      await safeLog('debug_no_verify', { note: 'Skipping signature verification (DEBUG_NO_VERIFY=1)' });
    }

    // Parse JSON
    let body: any = null;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      await safeLog('json_parse_error', { error: String(e) });
      res.statusCode = 200; // don't 400; just log so we can see payload format in logs
      res.end('bad json');
      return;
    }

    await safeLog('incoming', body);

    const type = extractEventType(body); // e.g., PAYMENT.UPDATED, PAYMENT.CREATED, ORDER.UPDATED, etc.
    const status = extractPaymentStatus(body); // e.g., COMPLETED, CANCELED, FAILED
    const plinkId = extractPaymentLinkId(body);

    if (!plinkId) {
      await safeLog('no_payment_link_id', { type, status });
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    // Look up the pending deposit we created at link time
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .select('*')
      .eq('provider_id', plinkId)
      .single();

    if (depErr || !dep) {
      await safeLog('no_matching_deposit', { plinkId, depErr });
      res.statusCode = 200;
      res.end('ok');
      return;
    }

    // Decide based on either event type or payment status
    const typeIsPayment = type.includes('PAYMENT');
    const completed =
      (typeIsPayment && type.includes('COMPLETED')) ||
      status === 'COMPLETED' ||
      status === 'CAPTURED' ||
      status === 'APPROVED';

    const canceledOrFailed =
      (typeIsPayment && (type.includes('CANCELED') || type.includes('FAILED'))) ||
      status === 'CANCELED' ||
      status === 'FAILED' ||
      status === 'DECLINED';

    if (completed) {
      // Mark deposit paid (if not already), then bump wallet
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      const { data: w } = await sb
        .from('wallets')
        .select('balance_cents')
        .eq('user_id', dep.user_id)
        .single();

      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);

      await safeLog('marked_paid', { deposit_id: dep.id, provider_id: plinkId, next_balance_cents: next });
    } else if (canceledOrFailed) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await safeLog('marked_canceled', { deposit_id: dep.id, provider_id: plinkId, status, type });
    } else {
      // Unknown / intermediate event — just log and 200 OK
      await safeLog('ignored_event', { type, status, plinkId });
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    // Never 400: log and return OK so Square doesn't retry forever
    await safeLog('handler_error', { error: String(e?.message || e) });
    res.statusCode = 200;
    res.end('ok');
  }
}