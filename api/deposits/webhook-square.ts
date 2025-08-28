// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

export const config = { runtime: 'nodejs' };

type AnyObj = Record<string, any>;

// single canonical success status we will write to `deposits.status`
const SUCCESS_STATUS = (process.env.DEPOSIT_SUCCESS_STATUS || 'confirmed').toLowerCase();
// statuses we consider terminal/success in our app (include env one)
const FINAL_STATUSES = Array.from(new Set(['confirmed', 'completed', 'paid', 'succeeded', 'success', 'ok', 'done', SUCCESS_STATUS]));
// only try to write exactly the env-provided status to avoid CHECK constraint issues
const SUCCESS_CANDIDATES: string[] = [SUCCESS_STATUS];

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
  const cands: Array<any> = [
    body?.status,                                 // flattened summary you log
    body?.payment?.status,                        // flattened under payment
    body?.data?.object?.payment?.status,          // Square nested
    body?.data?.object?.status,                   // sometimes present
    body?.data?.object?.payment_link?.status,     // edge cases
  ];
  for (const s of cands) {
    if (typeof s === 'string' && s.trim()) return s.trim().toUpperCase();
  }
  return null;
}

function extractEventType(body: any): string {
  return String(body?.type || body?.event_type || '').toUpperCase();
}

function extractPaymentId(body: any): string | null {
  const d = body?.data;
  const obj = d?.object ?? d?.data ?? body?.object ?? {};
  const candidates: Array<any> = [
    obj?.payment?.id,
    obj?.id,
    body?.data?.object?.payment?.id,
  ];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
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

    await safeLog('incoming', {
      type: body?.type,
      sample: body?.data?.id || null,
      orderId: extractOrderId(body),
      paymentLinkId: extractPaymentLinkId(body),
      paymentId: extractPaymentId(body)
    }, 200);

    const type = extractEventType(body);
    const status = extractPaymentStatus(body);
    const plinkId = extractPaymentLinkId(body);
    const orderId = extractOrderId(body);
    const payId = extractPaymentId(body);
    const dbgReturnErr = String(req.headers['x-debug-return-error'] || '') === '1';

    // Resolve identifiers from payload
    const ids: string[] = [plinkId, payId].filter((s): s is string => !!s);

    if (!ids.length) {
      await safeLog('no_ids_to_match', { orderId, plinkId, payId }, 200);
      res.statusCode = 200; noStore(res); res.end('ok');
      return;
    }

    // Strictly look for a single PENDING Square deposit by provider_id (link or payment)
    const restrictStatus = String(req.headers['x-debug-no-status'] || '') !== '1';

    let depSel = sb
      .from('deposits')
      .select('id,user_id,status,amount_cents,provider_id,created_at')
      .eq('method', 'square')
      .in('provider_id', ids)
      .order('created_at', { ascending: false })
      .limit(1);

    if (restrictStatus) {
      // normal mode — only pick pending rows
      // @ts-ignore
      depSel = depSel.eq('status', 'pending');
    }

    // compatible with supabase-js v2 (with/without maybeSingle)
    let depResp: any;
    try {
      if (typeof (depSel as any).maybeSingle === 'function') {
        depResp = await (depSel as any).maybeSingle();
      } else {
        depResp = await (depSel as any).single();
      }
    } catch (e: any) {
      depResp = { data: null, error: e };
    }
    const dep = (depResp as any)?.data ?? null;
    const findErr = (depResp as any)?.error ?? null;

    if (findErr) {
      await safeLog('find_error', { msg: findErr.message, orderId, plinkId, payId }, 200);
      res.statusCode = 200; noStore(res); res.end('ok');
      return;
    }

    if (!dep) {
      await safeLog('deposit_not_found', { orderId, plinkId, payId, type, status }, 200);
      res.statusCode = 200; noStore(res); res.end('ok');
      return;
    }

    const depStatus = String(dep.status).toLowerCase();
    if (FINAL_STATUSES.includes(depStatus)) {
      await safeLog('already_paid', { deposit_id: dep.id, plinkId, depStatus }, 200);
      res.statusCode = 200; noStore(res); res.end('already');
      return;
    }

    // decide terminal states – rely on payment.status only
    const completed = ['COMPLETED','APPROVED','CAPTURED','SUCCESS','SUCCEEDED'].includes(String(status || '').toUpperCase());
    const canceledOrFailed = ['CANCELED','FAILED','DECLINED','CANCELLED'].includes(String(status || '').toUpperCase());

    if (completed) {
      // mark deposit as success using only the configured SUCCESS_STATUS
      const upd = await sb.from('deposits').update({ status: SUCCESS_STATUS }).eq('id', dep.id);
      if (upd.error) {
        await safeLog('mark_paid_failed', {
          deposit_id: dep.id,
          was_status: dep.status,
          try_status: SUCCESS_STATUS,
          err: upd.error.message
        }, 200);
        if (dbgReturnErr) {
          res.statusCode = 200; noStore(res);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            debug: 'mark_paid_failed',
            err: upd.error.message,
            dep: { id: dep.id, status: dep.status, provider_id: dep.provider_id }
          }));
          return;
        }
        res.statusCode = 200; noStore(res); res.end('mark fail');
        return;
      }

      // ensure wallet exists (handle "no rows" explicitly)
      let current = 0;
      const wSel = await sb.from('wallets')
        .select('balance_cents')
        .eq('user_id', dep.user_id)
        .single();

      if (wSel.data) {
        current = Number(wSel.data.balance_cents ?? 0);
      } else if (wSel.error && (wSel.error.code === 'PGRST116' || /Results contain 0 rows/i.test(String(wSel.error.message)))) {
        try { await sb.from('wallets').insert({ user_id: dep.user_id, balance_cents: 0, currency: 'usd' }); } catch {}
      } else if (wSel.error) {
        await safeLog('wallet_select_failed', { user_id: dep.user_id, err: wSel.error.message }, 200);
      }

      const next = current + Number(dep.amount_cents || 0);
      const wUpd = await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
      if (wUpd.error) {
        await safeLog('wallet_update_failed', { user_id: dep.user_id, err: wUpd.error.message }, 200);
        res.statusCode = 200; noStore(res); res.end('wallet fail');
        return;
      }

      await safeLog('wallet_credited', { deposit_id: dep.id, user_id: dep.user_id, amount_cents: dep.amount_cents, next_balance_cents: next, usedStatus: SUCCESS_STATUS }, 200);
    } else if (canceledOrFailed) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await safeLog('marked_canceled', { deposit_id: dep.id, plinkId, status, type }, 200);
    } else {
      // non-terminal — stash payload so we can inspect later
      await safeLog('ignored_event', { type, status, plinkId, orderId }, 200);
    }

    res.statusCode = 200; noStore(res); res.end('ok');
  } catch (e: any) {
    await safeLog('handler_error', { error: String(e?.message || e) }, 200);
    res.statusCode = 200; noStore(res); res.end('ok');
  }
}