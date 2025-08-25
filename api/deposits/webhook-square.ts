// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }

    // verify signature (HMAC-SHA256, base64)
    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) { res.statusCode = 400; res.end('bad signature'); return; }

    const body = JSON.parse(raw.toString('utf8'));

    // Square sandbox events: body.type like "payment.updated"
    // Completion state is in data.object.payment.status === 'COMPLETED'
    const obj = body?.data?.object ?? {};
    const payment = obj?.payment ?? {};
    const status = String(payment?.status || '').toUpperCase();

    // Find a payment_link id in a few likely places
    const paymentLinkId =
      payment?.payment_link?.id ||
      payment?.payment_link_id ||
      obj?.payment_link?.id ||
      obj?.payment_link_id ||
      ''; // fallback empty

    // helpful tracing (no .catch on PostgrestBuilder)
    await sb.from('webhook_logs').insert({
      src: 'square',
      payload: body,
      note: `status=${status}, payment_link_id=${paymentLinkId || '(none)'}`
    });

    // We stored provider_id = payment_link.id when creating the link
    if (!paymentLinkId) { res.statusCode = 200; res.end('no payment_link_id'); return; }

    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .select('*')
      .eq('provider_id', paymentLinkId)
      .single();

    if (depErr || !dep) { res.statusCode = 200; res.end('no matching deposit'); return; }

    if (status === 'COMPLETED') {
      // mark paid and credit wallet
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      const { data: w } = await sb
        .from('wallets')
        .select('id,balance_cents')
        .eq('user_id', dep.user_id)
        .single();

      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);

      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { deposit_id: dep.id, credited: dep.amount_cents },
        note: 'credited'
      });
    } else if (status === 'CANCELED' || status === 'FAILED') {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { deposit_id: dep.id, status },
        note: 'canceled/failed'
      });
    }

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    // best-effort log; ignore errors from logging itself
    try {
      await sb.from('webhook_logs').insert({
        src: 'square',
        payload: { error: String(e?.message || e) },
        note: 'exception'
      });
    } catch {}
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}