// /api/deposits/create-square.ts
import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

const SQUARE_VERSION = '2024-06-20';

function baseUrl() {
  const env = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function sqFetch(path: string, init: RequestInit) {
  const r = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${(process.env.SQUARE_ACCESS_TOKEN || '').trim()}`,
      ...(init.headers || {}),
    },
  });
  const json = await r.json().catch(()=> ({}));
  if (!r.ok) {
    const msg = json?.errors?.[0]?.detail || `square ${path} failed (${r.status})`;
    throw new Error(msg);
  }
  return json;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  // Auth via headers
  const user = getUser(req);
  if (!user) { res.statusCode = 401; res.end(JSON.stringify({ error: 'no user' })); return; }

  try {
    const body = await readJsonBody(req);
    const cents = Number(body?.amount_cents || 0);
    if (!Number.isFinite(cents) || cents < 100) {
      res.statusCode = 400; res.end(JSON.stringify({ error: 'min $1.00' })); return;
    }

    const token = (process.env.SQUARE_ACCESS_TOKEN || '').trim();
    const locationId = (process.env.SQUARE_LOCATION_ID || '').trim();
    const publicUrl = (process.env.PUBLIC_URL || '').trim();
    if (!token || !locationId || !publicUrl) {
      res.statusCode = 500; res.end(JSON.stringify({ error: 'missing Square envs' })); return;
    }

    // Ensure wallet + create pending deposit
    await ensureUserAndWallet(sb, user);
    const { data: dep, error: depErr } = await sb.from('deposits').insert({
      user_id: user.id, method: 'square', amount_cents: cents, status: 'pending'
    }).select('*').single();
    if (depErr) throw depErr;

    // 1) Create an ORDER with reference_id = deposit.id  ✅ VERY IMPORTANT
    const orderPayload = {
      order: {
        location_id: locationId,
        reference_id: String(dep.id), // <-- this lets webhook find the deposit later
        line_items: [{
          name: 'DropSource Credits',
          quantity: '1',
          base_price_money: { amount: cents, currency: 'USD' },
        }],
      },
      idempotency_key: `order_${dep.id}_${Date.now()}`
    };
    const orderResp = await sqFetch('/v2/orders', { method: 'POST', body: JSON.stringify(orderPayload) });
    const orderId = orderResp?.order?.id as string;
    if (!orderId) throw new Error('Square order create failed (no id)');

    // 2) Create a Payment Link from that order
    // build payment link directly with inline order (no separate /v2/orders call)
const redirect = `${publicUrl}/balance.html?ok=1&uid=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.email || '')}`;

const linkPayload = {
  idempotency_key: `plink_${dep.id}_${Date.now()}`,
  order: {
    location_id: locationId,
    reference_id: String(dep.id), // <-- critical for webhook mapping
    line_items: [{
      name: 'DropSource Credits',
      quantity: '1',
      base_price_money: { amount: cents, currency: 'USD' },
    }],
  },
  checkout_options: { ask_for_shipping_address: false, redirect_url: redirect }
};

const linkResp = await sqFetch('/v2/online-checkout/payment-links', {
  method: 'POST',
  body: JSON.stringify(linkPayload),
});

const linkId = linkResp?.payment_link?.id as string | undefined;
const linkUrl = linkResp?.payment_link?.url as string | undefined;
if (!linkId || !linkUrl) throw new Error('Square payment link create failed');

await sb.from('deposits').update({ provider_id: linkId }).eq('id', dep.id);

res.setHeader('Content-Type', 'application/json');
res.end(JSON.stringify({
  url: linkUrl,
  deposit_id: dep.id,
  amount_cents: cents,
  method: 'square',
  payment_link_id: linkId
}));
  } catch (e: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}