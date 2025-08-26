// /api/deposits/create-square.ts

import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

/**
 * Creates a Square Online Checkout payment link and records a pending deposit.
 * Expects JSON body: { amount_cents: number }  // min 100 (=$1.00)
 *
 * Env required:
 *   - SQUARE_ENV = 'sandbox' | 'production'
 *   - SQUARE_ACCESS_TOKEN
 *   - SQUARE_LOCATION_ID
 *   - PUBLIC_URL (e.g. https://drop-source.vercel.app)
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end();
    return;
  }

  // Identify the user from your header-based auth helper
  const user = getUser(req);
  if (!user) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'no user' }));
    return;
  }

  try {
    // Parse and validate input
    const body = await readJsonBody(req);
    const cents = Number(body?.amount_cents || 0);
    if (!Number.isFinite(cents) || cents < 100) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'min $1.00' }));
      return;
    }

    // Make sure user + wallet rows exist
    await ensureUserAndWallet(sb, user);

    // Create a pending deposit row first
    const { data: dep, error: depErr } = await sb
      .from('deposits')
      .insert({
        user_id: user.id,
        method: 'square',
        amount_cents: cents,
        status: 'pending',
      })
      .select('*')
      .single();

    if (depErr) throw depErr;

    // Square config
    const base =
      (process.env.SQUARE_ENV || '').toLowerCase() === 'sandbox'
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';

    const token = process.env.SQUARE_ACCESS_TOKEN || '';
    const locationId = process.env.SQUARE_LOCATION_ID || '';
    const publicUrl = process.env.PUBLIC_URL || '';

    if (!token || !locationId || !publicUrl) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: 'missing Square env vars',
          missing: {
            SQUARE_ACCESS_TOKEN: !!token,
            SQUARE_LOCATION_ID: !!locationId,
            PUBLIC_URL: !!publicUrl,
          },
        })
      );
      return;
    }

    // After payment, send the buyer back to a status page
    const redirect = `${publicUrl}/balance.html?ok=1&uid=${encodeURIComponent(
      user.id
    )}&email=${encodeURIComponent(user.email || '')}`;

    // Create the Square Online Checkout payment link
    const sqRes = await fetch(`${base}/v2/online-checkout/payment-links`, {
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
        checkout_options: {
          ask_for_shipping_address: false,
          redirect_url: redirect,
        },
      }),
    });

    const json: any = await sqRes.json().catch(() => ({}));

    if (!sqRes.ok) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: json?.errors?.[0]?.detail || 'square failed',
          raw: json,
        })
      );
      return;
    }

    // Square payloads commonly look like: { payment_link: { id, url, ... } }
    const paymentLink = json?.payment_link || json?.result?.payment_link;
    if (!paymentLink?.id || !paymentLink?.url) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: 'square response missing payment_link',
          raw: json,
        })
      );
      return;
    }

    // Save provider id to your deposit row
    await sb
      .from('deposits')
      .update({ provider_id: paymentLink.id })
      .eq('id', dep.id);

    // Return link to the client
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        url: paymentLink.url,
        deposit_id: dep.id,
        payment_link_id: paymentLink.id,
        amount_cents: cents,
        method: 'square',
        env: (process.env.SQUARE_ENV || 'production').toLowerCase(),
      })
    );
  } catch (e: any) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: String(e?.message || e),
      })
    );
  }
}