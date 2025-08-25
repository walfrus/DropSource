import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

// ...rest unchanged...

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  const user = getUser(req);
  if (!user) { res.statusCode = 401; res.end(JSON.stringify({ error: 'no user' })); return; }

  try {
    const body = await readJsonBody(req);
    const cents = Number(body?.amount_cents || 0);
    if (!Number.isFinite(cents) || cents < 100) {
      res.statusCode = 400; res.end(JSON.stringify({ error: 'min $1.00' })); return;
    }

    await ensureUserAndWallet(sb, user);

    const { data: dep, error } = await sb.from('deposits').insert({
      user_id: user.id, method: 'square', amount_cents: cents, status: 'pending'
    }).select('*').single();
    if (error) throw error;

    const token = process.env.SQUARE_ACCESS_TOKEN || '';
    const locationId = process.env.SQUARE_LOCATION_ID || '';
    const redirect = `${process.env.PUBLIC_URL}/balance?ok=1`;

    const r = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2024-06-20',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        idempotency_key: `dep_${dep.id}_${Date.now()}`,
        quick_pay: {
          name: 'DropSource Credits',
          price_money: { amount: cents, currency: 'USD' },
          location_id: locationId
        },
        checkout_options: { ask_for_shipping_address: false, redirect_url: redirect }
      })
    });

    const json = await r.json();
    if (!r.ok) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: json?.errors?.[0]?.detail || 'square failed' }));
      return;
    }

    await sb.from('deposits').update({ provider_id: json?.payment_link?.id || null }).eq('id', dep.id);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: json?.payment_link?.url }));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}