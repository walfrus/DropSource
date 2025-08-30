// /api/deposits/webhook-coinbase.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
};

type AnyObj = Record<string, any>;

// tiny logger that never throws
async function safeLog(row: { source: string; event?: string; http_status?: number; payload?: any }) {
  try {
    await sb.from('webhook_logs').insert({
      source: row.source || 'app',
      event: row.event ?? null,
      http_status: Number.isFinite(row.http_status as number) ? (row.http_status as number) : 0,
      payload: row.payload ?? null,
    });
  } catch { /* ignore */ }
}

function noStore(res: any) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405; res.setHeader('Allow', 'POST'); noStore(res);
    res.end('Method not allowed');
    return;
  }

  // allow explicit bypass while testing
  const DEBUG_NO_VERIFY = process.env.DEBUG_NO_VERIFY === '1' || req.headers['x-debug-no-verify'] === '1';

  try {
    const raw = await readRawBody(req);

    // Coinbase signature (hex HMAC SHA256 of raw body)
    if (!DEBUG_NO_VERIFY) {
      const sig = req.headers['x-cc-webhook-signature'] as string | undefined;
      const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '';
      if (!sig || !secret) { res.statusCode = 400; noStore(res); res.end('missing signature'); return; }
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (sig !== expected) {
        await safeLog({ source: 'coinbase', event: 'SIG_MISMATCH', http_status: 400, payload: { got: sig } });
        res.statusCode = 400; noStore(res); res.end('bad signature');
        return;
      }
    }

    let body: AnyObj;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch {
      await safeLog({ source: 'coinbase', event: 'BAD_JSON', http_status: 400, payload: { raw: String(raw) } });
      res.statusCode = 400; noStore(res); res.end('bad json');
      return;
    }

    // optional metadata added when the charge was created
    const metadata: AnyObj = (body?.event?.data?.metadata || {}) as AnyObj;
    const metaDepositId = String(metadata.deposit_id || metadata.depositId || '') || '';

    const type = String(body?.event?.type || '');
    const data = body?.event?.data || {};
    const cbId = String(data?.id || '');
    const cbCode = String(data?.code || '');
    const providerId = cbId || cbCode; // prefer id, fallback to code

    await safeLog({ source: 'coinbase', event: type || 'unknown', http_status: 200, payload: { providerId, cbId, cbCode } });

    // find deposit by provider_id (try id first, then code if different)
    let { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerId).single();
    if (!dep && cbId && cbCode && cbCode !== cbId) {
      const alt = await sb.from('deposits').select('*').eq('provider_id', cbCode).single();
      dep = alt.data || null;
    }
    if (!dep && metaDepositId) {
      const byMeta = await sb.from('deposits').select('*').eq('id', metaDepositId).single();
      if (byMeta.data) {
        dep = byMeta.data;
        await safeLog({ source: 'coinbase', event: 'DEPOSIT_MATCHED_BY_METADATA', http_status: 200, payload: { deposit_id: dep.id } });
      }
    }
    if (!dep) {
      await safeLog({ source: 'coinbase', event: 'DEPOSIT_NOT_FOUND', http_status: 200, payload: { providerId } });
      res.statusCode = 200; noStore(res); res.end('no deposit');
      return;
    }

    // idempotency guard — do not double credit
    {
      const st = String(dep.status).toLowerCase();
      if (st === 'confirmed' || st === 'paid') {
        await safeLog({ source: 'coinbase', event: 'ALREADY_CONFIRMED', http_status: 200, payload: { deposit_id: dep.id, status: st } });
        res.statusCode = 200; noStore(res); res.end('already');
        return;
      }
    }

    if (type === 'charge:confirmed' || type === 'charge:resolved') {
      const successStatus = (process.env.DEPOSIT_SUCCESS_STATUS || 'confirmed').toLowerCase();
      const upd = await sb.from('deposits').update({ status: successStatus }).eq('id', dep.id);

      // credit wallet (ensure row exists, then update)
      const wSel = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
      const cur = Number(wSel.data?.balance_cents ?? 0);
      if (!wSel.data) {
        try { await sb.from('wallets').insert({ user_id: dep.user_id, balance_cents: 0, currency: 'usd' }); } catch {}
      }
      const next = cur + Number(dep.amount_cents || 0);
      const wUpd = await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
      if (wUpd.error) {
        await safeLog({ source: 'coinbase', event: 'WALLET_UPDATE_FAIL', http_status: 200, payload: { user_id: dep.user_id, err: wUpd.error.message } });
        res.statusCode = 200; noStore(res); res.end('wallet fail');
        return;
      }

      await safeLog({ source: 'coinbase', event: 'WALLET_CREDITED', http_status: 200, payload: { user_id: dep.user_id, amount_cents: dep.amount_cents } });
    } else if (type === 'charge:failed') {
      await sb.from('deposits').update({ status: 'failed' }).eq('id', dep.id);
    } else {
      // non-terminal events — just store latest payload
    }

    res.statusCode = 200; noStore(res); res.end('ok');
  } catch (e: any) {
    await safeLog({ source: 'coinbase', event: 'ERROR', http_status: 500, payload: { message: String(e?.message || e) } });
    res.statusCode = 500; noStore(res); res.end(String(e?.message || e));
  }
}