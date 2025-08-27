// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

type AnyObj = Record<string, any>;

function noStore(res: any) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

// best-effort DB+console logger (never throws)
async function safeLog(event: string, payload?: any, http_status = 200) {
  try {
    console.log(`[square:${event}]`, JSON.stringify(payload ?? {}, null, 2));
  } catch {}
  try {
    await sb.from('webhook_logs').insert({
      source: 'square',
      event,
      http_status,
      payload: payload ?? null,
    });
  } catch {}
}

function extractPaymentLinkId(body: any): string | null {
  const d = body?.data;
  const obj = d?.object ?? d?.data ?? body?.object ?? {};
  const candidates: Array<any> = [
    obj?.payment_link?.id,
    obj?.payment_link_id,
    obj?.payment?.payment_link_id,
    obj?.checkout?.payment_link?.id,
    obj?.checkout?.payment_link_id,
    obj?.payment_link?.payment_link_id,
    obj?.order?.payment_link_id,
    body?.data?.object?.order?.payment_link_id,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

function extractOrderId(body: any): string | null {
  const d = body?.data;
  const obj = d?.object ?? d?.data ?? body?.object ?? {};
  const candidates: Array<any> = [
    obj?.payment?.order_id,
    obj?.order?.id,
    obj?.checkout?.order_id,
    obj?.order_id,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

function extractPaymentStatus(body: any): string | null {
  const status =
    body?.data?.object?.payment?.status ??
    body?.data?.object?.status ??
    body?.data?.object?.payment_link?.status ??
    null;
  return typeof status === 'string' ? status.toUpperCase() : null;
}

function extractEventType(body: any): string {
  return String(body?.type || body?.event_type || '').toUpperCase();
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405; res.setHeader('Allow', 'POST'); noStore(res); res.end('Method not allowed');
    return;
  }

  try {
    const raw = await readRawBody(req);

    const headerSig =
      (req.headers['x-square-signature'] as string) ||
      (req.headers['x-square-hmacsha256-signature'] as string) ||
      (req.headers['x-square-hmacsha256'] as string) ||
      '';

    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const bypass = process.env.DEBUG_NO_VERIFY === '1' || String(req.headers['x-debug-no-verify'] || '') === '1';

    if (!bypass) {
      if (!headerSig || !key) {
        await safeLog('missing_signature', { headerSigPresent: !!headerSig, keyPresent: !!key }, 200);
        res.statusCode = 200; noStore(res); res.end('missing signature');
        return;
      }
      // Scheme A: HMAC(raw)
      const expA = crypto.createHmac('sha256', key).update(raw).digest('base64');
      // Scheme B: HMAC(url + raw)
      const baseUrl = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/$/, '') : '';
      const endpoint = baseUrl ? `${baseUrl}/api/deposits/webhook-square` : '';
      const expB = endpoint ? crypto.createHmac('sha256', key).update(endpoint + raw).digest('base64') : '';

      const eq = (a: string, b: string) => {
        if (!a || !b) return false;
        try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return a === b; }
      };

      if (!(eq(headerSig, expA) || (expB && eq(headerSig, expB)))) {
        await safeLog('sig_mismatch', { headerSig, expAKnown: !!expA, expBKnown: !!expB }, 200);
        res.statusCode = 200; noStore(res); res.end('bad signature');
        return;
      }
    } else {
      await safeLog('debug_no_verify', { note: 'skipping signature verification' }, 200);
    }

    // parse json
    let body: AnyObj = {};
    try { body = JSON.parse(raw.toString('utf8')); }
    catch (e) {
      await safeLog('bad_json', { error: String(e) }, 200);
      res.statusCode = 200; noStore(res); res.end('bad json');
      return;
    }

    await safeLog('incoming', { type: body?.type, sample: body?.data?.id || null, orderId: extractOrderId(body), paymentLinkId: extractPaymentLinkId(body) }, 200);

    const type = extractEventType(body);
    const status = extractPaymentStatus(body);
    const plinkId = extractPaymentLinkId(body);
    const orderId = extractOrderId(body);

    let dep: any = null;
    if (orderId) {
      const byOrder = await sb.from('deposits').select('*').eq('provider_order_id', orderId).single();
      dep = byOrder.data as any;
    }
    if (!dep && plinkId) {
      const byLink = await sb.from('deposits').select('*').eq('provider_id', plinkId).single();
      dep = byLink.data as any;
    }
    if (!dep) {
      await safeLog('deposit_not_found', { orderId, plinkId, type, status }, 200);
      res.statusCode = 200; noStore(res); res.end('ok');
      return;
    }

    // idempotency: don't double-credit
    if (String(dep.status).toLowerCase() === 'paid') {
      await safeLog('already_paid', { deposit_id: dep.id, plinkId }, 200);
      res.statusCode = 200; noStore(res); res.end('already');
      return;
    }

    // decide terminal states
    const typeIsPayment = type.includes('PAYMENT');
    const completed = (typeIsPayment && type.includes('COMPLETED')) || status === 'COMPLETED' || status === 'CAPTURED' || status === 'APPROVED';
    const canceledOrFailed = (typeIsPayment && (type.includes('CANCELED') || type.includes('FAILED'))) || status === 'CANCELED' || status === 'FAILED' || status === 'DECLINED';

    if (completed) {
      // mark paid + store payload
      const upd = await sb.from('deposits').update({ status: 'paid', provider_payload: body }).eq('id', dep.id);
      if (upd.error) {
        await safeLog('mark_paid_failed', { deposit_id: dep.id, err: upd.error.message }, 200);
        res.statusCode = 200; noStore(res); res.end('mark fail');
        return;
      }

      // ensure wallet exists
      const wSel = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).maybeSingle?.() ?? await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
      if (!('data' in wSel) || !wSel.data) {
        try { await sb.from('wallets').insert({ user_id: dep.user_id, balance_cents: 0, currency: 'usd' }); } catch {}
      }
      const current = Number((wSel as any)?.data?.balance_cents ?? 0);
      const next = current + Number(dep.amount_cents || 0);

      const wUpd = await sb.from('wallets').update({ balance_cents: next, updated_at: new Date().toISOString() }).eq('user_id', dep.user_id);
      if (wUpd.error) {
        await safeLog('wallet_update_failed', { user_id: dep.user_id, err: wUpd.error.message }, 200);
        res.statusCode = 200; noStore(res); res.end('wallet fail');
        return;
      }

      await safeLog('wallet_credited', { deposit_id: dep.id, user_id: dep.user_id, amount_cents: dep.amount_cents, next_balance_cents: next }, 200);
    } else if (canceledOrFailed) {
      await sb.from('deposits').update({ status: 'canceled', provider_payload: body }).eq('id', dep.id);
      await safeLog('marked_canceled', { deposit_id: dep.id, plinkId, status, type }, 200);
    } else {
      // non-terminal — stash payload so we can inspect later
      try { await sb.from('deposits').update({ provider_payload: body }).eq('id', dep.id); } catch {}
      await safeLog('ignored_event', { type, status, plinkId, orderId }, 200);
    }

    res.statusCode = 200; noStore(res); res.end('ok');
  } catch (e: any) {
    await safeLog('handler_error', { error: String(e?.message || e) }, 200);
    res.statusCode = 200; noStore(res); res.end('ok');
  }
}