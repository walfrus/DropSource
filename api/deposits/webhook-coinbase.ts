// /api/deposits/webhook-coinbase.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

type AnyObj = Record<string, any>;

// tiny logger that never throws
async function safeLog(row: { source: string; event?: string; http_status?: number; payload?: any }) {
  try {
    await sb.from('webhook_logs').insert({
      source: row.source || 'app',
      event: row.event ?? null,
      http_status: Number.isFinite(row.http_status as number) ? row.http_status : 0,
      payload: row.payload ?? null,
    });
  } catch {/* ignore */}
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  const DEBUG_NO_VERIFY = process.env.DEBUG_NO_VERIFY === '1';

  try {
    const raw = await readRawBody(req);

    // Coinbase signature (hex HMAC SHA256)
    if (!DEBUG_NO_VERIFY) {
      const sig = req.headers['x-cc-webhook-signature'] as string | undefined;
      const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '';
      if (!sig || !secret) { res.statusCode = 400; res.end('missing signature'); return; }
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (sig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }
    }

    const body: AnyObj = JSON.parse(raw.toString('utf8'));
    const type = String(body?.event?.type || '');
    const providerId = String(body?.event?.data?.id || '');

    await safeLog({
      source: 'coinbase',
      event: type,
      http_status: 200,
      payload: { providerId }
    });

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerId).single();
    if (!dep) { res.statusCode = 200; res.end('no deposit'); return; }

    if (type === 'charge:confirmed' || type === 'charge:resolved') {
      // mark paid
      const upd = await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      if (upd.error) {
        await safeLog({ source: 'coinbase', event: 'MARK_PAID_FAIL', http_status: 200, payload: { deposit_id: dep.id, err: upd.error.message } });
        res.statusCode = 200; res.end('mark fail'); return;
      }

      // credit wallet
      const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
      const cur  = Number(w?.balance_cents ?? 0);
      const next = cur + Number(dep.amount_cents || 0);

      const wUpd = await sb.from('wallets')
        .update({ balance_cents: next, updated_at: new Date().toISOString() })
        .eq('user_id', dep.user_id);

      if (wUpd.error) {
        await safeLog({ source: 'coinbase', event: 'WALLET_UPDATE_FAIL', http_status: 200, payload: { user_id: dep.user_id, err: wUpd.error.message } });
        res.statusCode = 200; res.end('wallet fail'); return;
      }

      await safeLog({ source: 'coinbase', event: 'WALLET_CREDITED', http_status: 200, payload: { user_id: dep.user_id, amount_cents: dep.amount_cents } });
    } else if (type === 'charge:failed') {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    await safeLog({ source: 'coinbase', event: 'ERROR', http_status: 500, payload: { message: String(e?.message || e) } });
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}