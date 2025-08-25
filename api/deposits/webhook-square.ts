// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }

  try {
    const skipVerify = process.env.DEBUG_NO_VERIFY === '1';

    let raw: Buffer;
    if (!skipVerify) {
      const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
      const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';

      raw = await readRawBody(req);
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');

      if (headerSig !== expected) {
        console.error('Webhook sig mismatch', { headerSig, expected });
        res.statusCode = 400;
        res.end('bad signature');
        return;
      }
    } else {
      raw = await readRawBody(req);
      console.warn('⚠️ Skipping signature verification (DEBUG_NO_VERIFY=1)');
    }

    const body = JSON.parse(raw.toString('utf8'));
    const type = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};
    const plinkId = obj?.payment_link?.id || obj?.payment_link_id || obj?.id || '';

    if (!plinkId) {
      res.statusCode = 200;
      res.end('no payment link id');
      return;
    }

    const { data: dep } = await sb.from('deposits').select('*').eq('provider_id', plinkId).single();
    if (!dep) {
      res.statusCode = 200;
      res.end('no deposit');
      return;
    }

    if (type.includes('PAYMENT') && type.includes('UPDATED')) {
      // Mark as paid + increment wallet
      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);

      const { data: w } = await sb.from('wallets')
        .select('id,balance_cents')
        .eq('user_id', dep.user_id)
        .single();

      const next = (w?.balance_cents || 0) + Number(dep.amount_cents || 0);
      await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
    } else if (type.includes('CANCELED') || type.includes('FAILED')) {
      await sb.from('deposits').update({ status: 'canceled' }).eq('id', dep.id);
    }

    // Optional logging
    await sb.from('webhook_logs').insert({
      provider: 'square',
      event_type: type,
      payload: body,
      deposit_id: dep?.id || null,
      created_at: new Date().toISOString(),
    });

    res.statusCode = 200;
    res.end('ok');
  } catch (e: any) {
    console.error('Webhook-square handler error', e);
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}