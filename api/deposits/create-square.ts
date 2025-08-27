// /api/deposits/create-square.ts
import { randomBytes } from 'crypto';
import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

type Json = Record<string, any>;

function send(res: any, code: number, body: Json) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.end(JSON.stringify(body));
}

function dollarsToCents(x: any): number {
  if (x == null || x === '') return NaN;
  const n = Number(x);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'method_not_allowed' });
  }

  const user = getUser(req);
  if (!user) return send(res, 401, { error: 'no user' });

  const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
  if (!ACCESS_TOKEN) return send(res, 500, { error: 'missing SQUARE_ACCESS_TOKEN' });

  const isProd = (process.env.SQUARE_ENV || '').toLowerCase() === 'production';
  const BASE = isProd ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';

  try {
    const body = await readJsonBody(req);

    // accept amount_cents OR amount_dollars / amount
    let amount_cents = Number(body?.amount_cents);
    if (!Number.isFinite(amount_cents)) {
      const alt = body?.amount_dollars ?? body?.amount;
      amount_cents = dollarsToCents(alt);
    }
    if (!Number.isFinite(amount_cents)) amount_cents = 0;
    amount_cents = Math.round(amount_cents);

    if (amount_cents < 100) return send(res, 400, { error: 'min $1.00', hint: 'amount_cents >= 100' });

    // ensure user + wallet rows exist
    await ensureUserAndWallet(sb, user);

    // create pending deposit record
    const depIns = await sb
      .from('deposits')
      .insert({ user_id: user.id, method: 'square', amount_cents, status: 'pending' })
      .select('*')
      .single();

    if (depIns.error) throw depIns.error;
    const dep = depIns.data as any;

    // choose location id (use configured first, else fetch)
    let locationId = process.env.SQUARE_LOCATION_ID || '';
    if (!locationId) {
      const rLoc = await fetch(`${BASE}/v2/locations`, {
        method: 'GET',
        headers: {
          'Square-Version': '2024-06-20',
          'Authorization': `Bearer ${ACCESS_TOKEN}`
        }
      });
      const jLoc = await rLoc.json().catch(() => ({}));
      locationId = jLoc?.locations?.find((l: any) => l?.status === 'ACTIVE')?.id || jLoc?.locations?.[0]?.id || '';
      if (!rLoc.ok || !locationId) throw new Error('No Square location found');
    }

    // build redirect back to balance page with user context (uid/email)
    const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const host = (req.headers['host'] as string) || '';
    const baseUrl = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL) : `${proto}://${host}`;
    const q = `uid=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.email || '')}`;
    const redirect = `${baseUrl.replace(/\/$/, '')}/balance.html?ok=1&${q}`;

    // create payment link
    const payload = {
      idempotency_key: `dep_${dep.id}_${Date.now()}_${randomBytes(6).toString('hex')}`,
      quick_pay: {
        name: 'DropSource Credits',
        price_money: { amount: amount_cents, currency: 'USD' },
        location_id: locationId,
      },
      checkout_options: { ask_for_shipping_address: false, redirect_url: redirect },
    } as const;

    const r = await fetch(`${BASE}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': '2024-06-20',
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    let json: any = null;
    try { json = await r.json(); } catch {}

    if (!r.ok) {
      // mark failed + log for visibility
      try {
        await sb.from('deposits').update({ status: 'failed', provider_payload: json }).eq('id', dep.id);
        await sb.from('webhook_logs').insert({
          source: 'square',
          event: 'create_failed',
          http_status: r.status,
          payload: { req: payload, res: json, depositId: dep.id },
        });
      } catch {}
      return send(res, 400, { error: json?.errors?.[0]?.detail || 'square_failed', status: r.status });
    }

    const paymentLink = json?.payment_link;

    // Ensure we have an order_id (some sandbox responses omit it on create)
    let orderId: string | null = paymentLink?.order_id || null;
    if (!orderId && paymentLink?.id) {
      try {
        const r2 = await fetch(`${BASE}/v2/online-checkout/payment-links/${paymentLink.id}`, {
          method: 'GET',
          headers: {
            'Square-Version': '2024-06-20',
            'Authorization': `Bearer ${ACCESS_TOKEN}`
          }
        });
        const j2: any = await r2.json().catch(() => ({}));
        const pl2 = j2?.payment_link;
        if (pl2?.order_id) {
          orderId = pl2.order_id;
        }
        // backfill url if not present
        if (!paymentLink?.url && pl2?.url) {
          (paymentLink as any).url = pl2.url;
        }
      } catch {}
    }

    await sb.from('deposits').update({
      provider_id: paymentLink?.id || null,
      provider_order_id: orderId || null,
      provider_payload: json
    }).eq('id', dep.id);

    try {
      await sb.from('webhook_logs').insert({
        source: 'square',
        event: 'create_ok',
        http_status: 200,
        payload: {
          depositId: dep.id,
          provider_id: paymentLink?.id,
          order_id: orderId,
          url: paymentLink?.url,
          amount_cents
        },
      });
    } catch {}

    return send(res, 200, {
      url: paymentLink?.url,
      deposit_id: dep.id,
      payment_link_id: paymentLink?.id,
      order_id: orderId,
      amount_cents,
      method: 'square',
      env: isProd ? 'production' : 'sandbox',
      location_id: locationId,
    });
  } catch (e: any) {
    try {
      await sb.from('webhook_logs').insert({
        source: 'square',
        event: 'create_exception',
        http_status: 500,
        payload: { error: String(e?.message || e) },
      });
    } catch {}
    return send(res, 500, { error: e?.message || String(e) });
  }
}