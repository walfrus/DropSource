// api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

type J = Record<string, any>;

function ok(res: any, text = 'ok') {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end(text);
}
function bad(res: any, code: number, text: string) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain');
  res.end(text);
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
  if (!headerSig || !key) return bad(res, 400, 'missing signature');

  try {
    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (headerSig !== expected) return bad(res, 400, 'bad signature');

    const body: J = JSON.parse(raw.toString('utf8'));
    const type = String(body?.type || body?.event_type || '').toLowerCase();

    const obj: J =
      body?.data?.object ||
      body?.data?.object?.payment ||
      body?.data?.object?.checkout ||
      {};

    const paymentLinkId: string =
      obj?.payment_link?.id ||
      obj?.payment_link_id ||
      obj?.checkout?.payment_link?.id ||
      obj?.id ||
      '';

    if (!paymentLinkId) return ok(res, 'no payment_link id');

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', paymentLinkId).single();
    if (!dep) return ok(res, 'no deposit');

    await sb.from('deposits').update({ provider_payload: body }).eq('id', dep.id);

    if (dep.status === 'paid' || dep.status === 'canceled') return ok(res, 'already finalized');

    const status = String(
      obj?.payment?.status || obj?.status || body?.data?.object?.payment?.status || ''
    ).toUpperCase();

    const isCompleted = status === 'COMPLETED' || type.includes('payment.updated');
    const isCanceled  = status === 'CANCELED'  || type.includes('canceled') || type.includes('failed');

    if (isCompleted) {
      await sb.from('deposits').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', dep.id);

      const { error: rpcErr } = await sb.rpc('increment_wallet', {
        p_user_id: dep.user_id,
        p_delta_cents: dep.amount_cents,
      });
      if (rpcErr) {
        const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
        const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
        await sb.from('wallets').update({ balance_cents: next, updated_at: new Date().toISOString() }).eq('user_id', dep.user_id);
      }
    } else if (isCanceled) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    return ok(res);
  } catch (e: any) {
    return bad(res, 500, String(e?.message || e));
  }
}