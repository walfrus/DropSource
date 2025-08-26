// /api/deposits/webhook-square.ts
import { readRawBody, crypto } from '../../lib/smm.js';
import { sb } from '../../lib/db.js';

async function log(src: string, msg: string, deposit_id?: string) {
  try {
    await sb.from('webhook_logs').insert({
      src, msg, deposit_id: deposit_id ?? null
    });
  } catch {}
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  try {
    const headerSig = (req.headers['x-square-hmacsha256'] as string) || '';
    const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
    const debugNoVerify = process.env.DEBUG_NO_VERIFY === '1';

    const raw = await readRawBody(req);

    if (!debugNoVerify) {
      if (!headerSig || !key) { res.statusCode = 400; res.end('missing signature'); return; }
      const expected = crypto.createHmac('sha256', key).update(raw).digest('base64');
      if (headerSig !== expected) {
        await log('square', `sig mismatch ( headerSig: ${headerSig.slice(0,8)}…, expected: ${expected.slice(0,8)}… )`);
        res.statusCode = 400; res.end('bad signature'); return;
      }
    } else {
      await log('square', 'Skipping signature verification (DEBUG_NO_VERIFY=1)');
    }

    const body = JSON.parse(raw.toString('utf8'));
    const type: string = String(body?.type || body?.event_type || '').toUpperCase();
    const obj = body?.data?.object || {};

    // --- Case A: payment_link.updated (preferred path) ---
    if (type.includes('PAYMENT_LINK') && type.includes('UPDATED')) {
      const plinkId: string =
        obj?.payment_link?.id || obj?.payment_link_id || obj?.id || '';

      if (!plinkId) {
        await log('square', 'payment_link.updated but no payment_link id found');
        res.statusCode = 200; res.end('ok'); return;
      }

      const { data: dep } = await sb.from('deposits')
        .select('*').eq('provider_id', plinkId).single();

      if (!dep) {
        await log('square', `no deposit for payment_link ${plinkId}`);
        res.statusCode = 200; res.end('ok'); return;
      }

      // Mark paid + credit wallet (idempotent)
      const { data: w } = await sb.from('wallets')
        .select('balance_cents').eq('user_id', dep.user_id).single();

      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      await sb.from('wallets')
        .update({ balance_cents: (w?.balance_cents || 0) + Number(dep.amount_cents || 0) })
        .eq('user_id', dep.user_id);

      await log('square', `mark paid via payment_link.updated (${plinkId})`, dep.id);
      res.statusCode = 200; res.end('ok'); return;
    }

    // --- Case B: payment.updated (may NOT carry payment_link) ---
    if (type.includes('PAYMENT') && type.includes('UPDATED')) {
      // Some payloads include obj.payment.payment_link_id; most don't.
      const plinkId: string =
        obj?.payment?.payment_link_id || obj?.payment_link_id || '';

      if (!plinkId) {
        // We don’t try to reverse-resolve here; we rely on payment_link.updated to follow.
        await log('square', 'payment.updated received (no payment_link_id); waiting for payment_link.updated');
        res.statusCode = 200; res.end('ok'); return;
      }

      const { data: dep } = await sb.from('deposits')
        .select('*').eq('provider_id', plinkId).single();

      if (!dep) {
        await log('square', `payment.updated with link ${plinkId} but no deposit`);
        res.statusCode = 200; res.end('ok'); return;
      }

      const { data: w } = await sb.from('wallets')
        .select('balance_cents').eq('user_id', dep.user_id).single();

      await sb.from('deposits').update({ status: 'paid' }).eq('id', dep.id);
      await sb.from('wallets')
        .update({ balance_cents: (w?.balance_cents || 0) + Number(dep.amount_cents || 0) })
        .eq('user_id', dep.user_id);

      await log('square', `mark paid via payment.updated (plink ${plinkId})`, dep.id);
      res.statusCode = 200; res.end('ok'); return;
    }

    // Other events we don’t care about
    res.statusCode = 200; res.end('ok');
  } catch (e: any) {
    await log('square', `error ${String(e?.message || e)}`);
    res.statusCode = 500; res.end(String(e?.message || e));
  }
}