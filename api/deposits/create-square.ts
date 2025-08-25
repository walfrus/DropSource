// /api/deposits/create-square.ts
// Creates a Square Checkout payment link and records a pending deposit.
// Env needed (all strings):
//   - SQUARE_ENV = "sandbox" | "production"
//   - SQUARE_ACCESS_TOKEN
//   - SQUARE_LOCATION_ID
//   - PUBLIC_URL (e.g. https://drop-source.vercel.app)

import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

type CreateLinkResp = {
  payment_link?: { id?: string; url?: string };
  errors?: Array<{ detail?: string }>;
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }

  // 1) Auth: we expect x-user-id / x-user-email headers (handled in getUser)
  const user = getUser(req);
  if (!user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'no user' }));
    return;
  }

  try {
    // 2) Validate input
    const body = await readJsonBody(req);
    const cents = Number(body?.amount_cents || 0);
    if (!Number.isFinite(cents) || cents < 100) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'min $1.00' }));
      return;
    }

    // 3) Ensure wallet row exists
    await ensureUserAndWallet(sb, user);

    // 4) Insert pending deposit (method must match your DB CHECK constraint)
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .insert({
        user_id: user.id,
        method: 'square',
        amount_cents: cents,
        status: 'pending'
      })
      .select('*')
      .single();

    if (depErr) throw depErr;

    // 5) Square API call
    const env = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
    const base =
      env === 'production'
        ? 'https://connect.squareup.com'
        : 'https://connect.squareupsandbox.com';

    const token = process.env.SQUARE_ACCESS_TOKEN || '';
    const locationId = process.env.SQUARE_LOCATION_ID || '';
    const publicUrl = process.env.PUBLIC_URL || '';

    if (!token || !locationId || !publicUrl) {
      throw new Error('Missing Square env: SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID / PUBLIC_URL');
    }

    const redirect = `${publicUrl}/balance?ok=1`;
    const idempotencyKey = `dep_${dep.id}_${Date.now()}`;

    const r = await fetch(`${base}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2024-06-20',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: 'DropSource Credits',
          price_money: { amount: cents, currency: 'USD' },
          location_id: locationId
        },
        checkout_options: {
          ask_for_shipping_address: false,
          redirect_url: redirect
        }
      })
    });

    const json = (await r.json()) as CreateLinkResp;

    if (!r.ok) {
      const msg =
        json?.errors?.[0]?.detail ||
        `square failed (HTTP ${r.status})`;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: msg }));
      return;
    }

    const linkId = json?.payment_link?.id || null;
    const linkUrl = json?.payment_link?.url || null;

    // 6) Save provider_id for later reconciliation in webhook
    await sb.from('deposits').update({ provider_id: linkId }).eq('id', dep.id);

    // 7) Return link to client
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        url: linkUrl,
        deposit_id: dep.id,
        amount_cents: cents,
        method: 'square'
      })
    );
  } catch (e: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}