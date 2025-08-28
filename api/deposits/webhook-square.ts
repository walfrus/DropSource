// /api/deposits/webhook-square.ts — self‑contained
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';

export const config = { runtime: 'nodejs' };

function json(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function text(res: any, code: number, t: string) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(t);
}

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null as any;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function readRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve());
    req.on('error', (e: any) => reject(e));
  });
  return Buffer.concat(chunks);
}

async function logWebhook(sb: any, event: string, http_status: number, payload: any) {
  try { await sb.from('webhook_logs').insert({ source: 'square', event, http_status, payload }); } catch {}
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return text(res, 200, 'ok');

  const sb = supabaseAdmin();
  if (!sb) {
    try { await logWebhook({ from: 'no_sb' }, 'missing_env', 500, { hasUrl: !!process.env.SUPABASE_URL, hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY }); } catch {}
    return json(res, 500, { error: 'server_misconfigured' });
  }
  const debugNoVerify = String(req.headers['x-debug-no-verify'] || '') === '1';
  const debugReturnError = String(req.headers['x-debug-return-error'] || '') === '1';

  try {
    // 1) Verify webhook HMAC (unless disabled for local tests)
    const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const headerSig = String(req.headers['x-square-hmacsha256'] || '');
    const raw = await readRawBody(req);

    if (!debugNoVerify) {
      if (!secret || !headerSig) {
        await logWebhook(sb, 'missing_signature', 400, { hasSecret: !!secret, hasHeader: !!headerSig });
        return json(res, 400, { error: 'missing signature' });
      }
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64');
      if (expected !== headerSig) {
        await logWebhook(sb, 'bad_signature', 400, { expected, headerSig });
        return json(res, 400, { error: 'bad signature' });
      }
    }

    // 2) Parse payload
    const body = JSON.parse(raw.toString('utf8') || '{}');
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};
    const payment = obj?.payment || obj?.object?.payment || {};
    const status = String(payment?.status || '').toUpperCase();
    const amount = Number(payment?.amount_money?.amount || 0);
    const linkId = obj?.payment_link_id || obj?.payment_link?.id || payment?.payment_link_id || '';
    const orderId = payment?.order_id || obj?.order_id || '';
    const providerKey = String(linkId || orderId || '');

    if (!providerKey) {
      await logWebhook(sb, 'no_provider_key', 200, { type, body });
      return text(res, 200, 'ok');
    }

    // 3) Find matching deposit by provider_id (try linkId, orderId, paymentId)
    const paymentId = String(payment?.id || '');
    const candidates = Array.from(new Set([providerKey, linkId, orderId, paymentId].filter(Boolean)));
    let dep: any = null;
    for (const key of candidates) {
      const { data } = await sb.from('deposits').select('*').eq('provider_id', key).single();
      if (data) { dep = data; break; }
    }
    if (!dep) {
      await logWebhook(sb, 'deposit_not_found', 200, { candidates, type, status });
      return text(res, 200, 'ok');
    }

    // 4) Only on completed/approved payments
    const completed = type.includes('PAYMENT') && (status === 'COMPLETED' || status === 'APPROVED');
    if (!completed) {
      await logWebhook(sb, 'ignored_event', 200, { type, status, providerKey });
      return text(res, 200, 'ok');
    }

    // 5) Mark deposit confirmed (use a schema-safe value)
    const successStatus = 'confirmed';
    try { await sb.from('deposits').update({ status: successStatus }).eq('id', dep.id); } catch {}

    // 6) Credit wallet
    const user_id = dep.user_id;
    const cents = Number(dep.amount_cents || amount || 0);
    if (user_id && cents > 0) {
      // ensure user exists
      await sb.from('users').upsert({ id: user_id, email: null }).select('id').single();
      // ensure wallet exists (no 409): onConflict user_id
      await sb.from('wallets').upsert(
        { user_id, balance_cents: 0, currency: 'usd' },
        { onConflict: 'user_id' }
      );
      const { data: w3 } = await sb.from('wallets').select('balance_cents').eq('user_id', user_id).single();
      const next = Number(w3?.balance_cents || 0) + cents;
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', user_id);
    }

    await logWebhook(sb, 'paid', 200, { dep_id: dep.id, providerKey, cents });
    return text(res, 200, 'ok');
  } catch (e: any) {
    await logWebhook(sb, 'handler_error', 200, { error: String(e?.message || e) });
    if (debugReturnError) return json(res, 200, { error: 'handler_error', message: String(e?.message || e) });
    return text(res, 200, 'ok');
  }
}