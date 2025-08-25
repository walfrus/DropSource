// api/deposits/create-coinbase.ts
import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

type Json = Record<string, any>;

function send(res: any, code: number, body: Json) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

  const user = getUser(req);
  if (!user) return send(res, 401, { error: 'no user' });

  const apiKey = process.env.COINBASE_COMMERCE_API_KEY || '';
  const publicUrl = process.env.PUBLIC_URL || process.env.VERCEL_URL || '';

  if (!apiKey)    return send(res, 500, { error: 'missing COINBASE_COMMERCE_API_KEY' });
  if (!publicUrl) return send(res, 500, { error: 'missing PUBLIC_URL' });

  try {
    const body = await readJsonBody(req);
    const cents = Number(body?.amount_cents || 0);
    if (!Number.isFinite(cents) || cents < 100) {
      return send(res, 400, { error: 'min $1.00', hint: 'amount_cents >= 100' });
    }

    await ensureUserAndWallet(sb, user);

    // create pending deposit (method must match DB CHECK)
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .insert({
        user_id: user.id,
        method: 'coinbase',        // <-- matches deposits_method_check
        amount_cents: cents,
        status: 'pending',
      })
      .select('*')
      .single();

    if (depErr) throw depErr;

    const base = `https://${String(publicUrl).replace(/^https?:\/\//, '')}`;
    const redirect = `${base}/balance?ok=1`;
    const cancel   = `${base}/balance?canceled=1`;

    // Coinbase Commerce charge
    const resp = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': apiKey,
        'X-CC-Version': '2018-03-22',
      },
      body: JSON.stringify({
        name: 'DropSource Credits',
        pricing_type: 'fixed_price',
        local_price: { amount: (cents / 100).toFixed(2), currency: 'USD' },
        metadata: { userId: user.id, depositId: dep.id },
        redirect_url: redirect,
        cancel_url: cancel,
      }),
    });

    const json = await resp.json();

    if (!resp.ok) {
      await sb.from('deposits').update({
        status: 'failed',
        provider_payload: json,
      }).eq('id', dep.id);
      return send(res, 400, { error: json?.error?.message || 'coinbase_failed' });
    }

    await sb.from('deposits').update({
      provider_id: json?.data?.id || null,
      provider_payload: json,
    }).eq('id', dep.id);

    return send(res, 200, {
      url: json?.data?.hosted_url,
      deposit_id: dep.id,
      amount_cents: cents,
      method: 'coinbase',
    });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || String(e) });
  }
}