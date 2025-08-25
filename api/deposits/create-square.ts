// api/deposits/create-square.ts
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

  const token = process.env.SQUARE_ACCESS_TOKEN || '';
  const locationId = process.env.SQUARE_LOCATION_ID || '';
  const publicUrl = process.env.PUBLIC_URL || process.env.VERCEL_URL || '';

  if (!token)       return send(res, 500, { error: 'missing SQUARE_ACCESS_TOKEN' });
  if (!locationId)  return send(res, 500, { error: 'missing SQUARE_LOCATION_ID' });
  if (!publicUrl)   return send(res, 500, { error: 'missing PUBLIC_URL' });

  try {
    const body = await readJsonBody(req);
    const cents = Number(body?.amount_cents || 0);
    if (!Number.isFinite(cents) || cents < 100) {
      return send(res, 400, { error: 'min $1.00', hint: 'amount_cents >= 100' });
    }

    // ensure wallet exists for this user
    await ensureUserAndWallet(sb, user);

    // insert pending deposit (method must match DB CHECK exactly)
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .insert({
        user_id: user.id,
        method: 'square',          // <-- matches deposits_method_check
        amount_cents: cents,
        status: 'pending',
      })
      .select('*')
      .single();

    if (depErr) throw depErr;

    const redirect = `https://${String(publicUrl).replace(/^https?:\/\//, '')}/balance?ok=1`;

    // Create a payment link via Square API
    const resp = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2024-06-20',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        idempotency_key: `dep_${dep.id}_${Date.now()}`,
        quick_pay: {
          name: 'DropSource Credits',
          price_money: { amount: cents, currency: 'USD' },
          location_id: locationId,
        },
        checkout_options: { ask_for_shipping_address: false, redirect_url: redirect },
      }),
    });

    const json = await resp.json();

    if (!resp.ok) {
      // mark as failed for traceability
      await sb.from('deposits').update({
        status: 'failed',
        provider_payload: json,
      }).eq('id', dep.id);
      return send(res, 400, { error: json?.errors?.[0]?.detail || 'square_failed' });
    }

    // persist provider reference
    await sb.from('deposits').update({
      provider_id: json?.payment_link?.id || null,
      provider_payload: json,
    }).eq('id', dep.id);

    return send(res, 200, {
      url: json?.payment_link?.url,
      deposit_id: dep.id,
      amount_cents: cents,
      method: 'square',
    });
  } catch (e: any) {
    return send(res, 500, { error: e?.message || String(e) });
  }
}