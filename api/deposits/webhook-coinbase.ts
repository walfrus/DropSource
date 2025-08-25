// api/deposits/webhook-coinbase.ts
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

  const sig = req.headers['x-cc-webhook-signature'] as string | undefined;
  const secret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || '';
  if (!sig || !secret) return bad(res, 400, 'missing signature');

  try {
    const raw = await readRawBody(req);
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (sig !== expected) return bad(res, 400, 'bad signature');

    const body: J = JSON.parse(raw.toString('utf8'));
    const eventType: string = body?.event?.type || '';
    const providerId: string = body?.event?.data?.id || '';
    if (!providerId) return ok(res, 'no provider id');

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', providerId).single();
    if (!dep) return ok(res, 'no deposit');

    // persist latest payload
    await sb.from('deposits').update({ provider_payload: body }).eq('id', dep.id);

    if (dep.status === 'paid' || dep.status === 'canceled') return ok(res, 'already finalized');

    const paidTypes = new Set(['charge:confirmed', 'charge:resolved', 'charge:delayed']);
    const failedTypes = new Set(['charge:failed', 'charge:pending_expired']);

    if (paidTypes.has(eventType)) {
      await sb.from('deposits').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', dep.id);

      // Prefer DB function; fall back if absent
      const { error: rpcErr } = await sb.rpc('increment_wallet', {
        p_user_id: dep.user_id,
        p_delta_cents: dep.amount_cents,
      });
      if (rpcErr) {
        const { data: w } = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
        const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
        await sb.from('wallets').update({ balance_cents: next, updated_at: new Date().toISOString() }).eq('user_id', dep.user_id);
      }
    } else if (failedTypes.has(eventType)) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    return ok(res);
  } catch (e: any) {
    return bad(res, 500, String(e?.message || e));
  }
}