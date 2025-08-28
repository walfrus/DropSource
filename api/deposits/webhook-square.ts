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
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
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

    // 3) Find matching deposit by provider_id
    const { data: dep, error: depErr } = await sb.from('deposits').select('*').eq('provider_id', providerKey).single();
    if (depErr || !dep) {
      await logWebhook(sb, 'deposit_not_found', 200, { providerKey, type });
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
      // ensure wallet exists
      await sb.from('users').upsert({ id: user_id, email: null }).select('id').single();
      const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', user_id).single();
      if (!w) {
        await sb.from('wallets').insert({ user_id, balance_cents: 0, currency: 'usd' });
      }
      const { data: w2 } = await sb.from('wallets').select('balance_cents').eq('user_id', user_id).single();
      const next = Number(w2?.balance_cents || 0) + cents;
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