// /api/deposits/webhook-square.ts
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
  } catch {/* never block webhooks on logging */}
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  const DEBUG_NO_VERIFY = process.env.DEBUG_NO_VERIFY === '1';

  try {
    const raw = await readRawBody(req);

    // --- Signature verification (can bypass with DEBUG_NO_VERIFY=1) ---
    if (!DEBUG_NO_VERIFY) {
      const headerSig = String(req.headers['x-square-hmacsha256'] || '');
      const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
      if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
      if (headerSig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }
    }

    // --- Parse body ---
    const body: AnyObj = JSON.parse(raw.toString('utf8'));

    const eventType = String(body?.type || body?.event_type || '').toUpperCase();
    const obj       = body?.data?.object ?? {};
    const payment   = obj?.payment ?? obj?.object ?? obj?.data?.object?.payment;

    // Payment link id appears in different spots depending on the event
    const paymentLinkId =
      payment?.payment_link_id ??
      obj?.payment_link?.id ??
      obj?.payment_link_id ??
      obj?.id ?? '';

    const status = String(payment?.status || '').toUpperCase();
    const isFailure = status === 'FAILED' || status === 'CANCELED' || status === 'REFUNDED';
    // Sandbox often fires PAYMENT.UPDATED on success; treat any non-failure PAYMENT.* as paid
    const looksPaid = eventType.startsWith('PAYMENT') && !isFailure;

    await safeLog({
      source: 'square',
      event: eventType,
      http_status: 200,
      payload: {
        status,
        paymentLinkId,
        keys: Object.keys(obj || {}),
      }
    });

    if (!looksPaid) { res.statusCode = 200; res.end('ignored'); return; }
    if (!paymentLinkId) { res.statusCode = 200; res.end('no payment link id'); return; }

    // Find our deposit created by /create-square (provider_id == payment_link.id)
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .select('*')
      .eq('provider_id', paymentLinkId)
      .single();

    if (depErr || !dep) {
      await safeLog({ source: 'square', event: 'NO_DEPOSIT', http_status: 200, payload: { paymentLinkId, depErr: depErr?.message } });
      res.statusCode = 200; res.end('no deposit'); return;
    }

    if (dep.status === 'paid') { res.statusCode = 200; res.end('already paid'); return; }

    // Mark deposit paid
    const upd = await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
    if (upd.error) {
      await safeLog({ source: 'square', event: 'MARK_PAID_FAIL', http_status: 200, payload: { deposit_id: dep.id, err: upd.error.message } });
      res.statusCode = 200; res.end('mark fail'); return;
    }

    // Ensure wallet exists, then credit
    const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
    const cur  = Number(w?.balance_cents ?? 0);
    const next = cur + Number(dep.amount_cents || 0);

    const wUpd = await sb.from('wallets')
      .update({ balance_cents: next, updated_at: new Date().toISOString() })
      .eq('user_id', dep.user_id);

    if (wUpd.error) {
      await safeLog({ source: 'square', event: 'WALLET_UPDATE_FAIL', http_status: 200, payload: { user_id: dep.user_id, err: wUpd.error.message } });
      res.statusCode = 200; res.end('wallet fail'); return;
    }

    await safeLog({
      source: 'square',
      event: 'WALLET_CREDITED',
      http_status: 200,
      payload: { user_id: dep.user_id, amount_cents: dep.amount_cents, payment_link_id: paymentLinkId }
    });

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    await safeLog({ source: 'square', event: 'ERROR', http_status: 500, payload: { message: String(e?.message || e) } });
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}