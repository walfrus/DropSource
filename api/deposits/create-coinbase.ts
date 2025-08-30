// api/deposits/create-coinbase.ts
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
  // round to cents defensively
  return Math.round(n * 100);
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

    // accept either amount_cents or amount_dollars/amount
    let cents = Number(body?.amount_cents);
    if (!Number.isFinite(cents)) {
      const alt = body?.amount_dollars ?? body?.amount;
      cents = dollarsToCents(alt);
    }
    if (!Number.isFinite(cents)) cents = 0;
    cents = Math.round(cents);

    if (cents < 100) {
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
    const q = `uid=${encodeURIComponent(user.id)}&email=${encodeURIComponent(user.email ?? '')}`;
    const redirect = `${base}/balance.html?ok=1&${q}`;
    const cancel   = `${base}/balance.html?canceled=1&${q}`;

    const payload: any = {
      name: 'DropSource Credits',
      pricing_type: 'fixed_price',
      local_price: { amount: (cents / 100).toFixed(2), currency: 'USD' },
      metadata: {
        userId: user.id,
        depositId: dep.id,
        // snake_case duplicates so webhook fallback matchers can use these
        user_id: user.id,
        deposit_id: dep.id,
      },
      redirect_url: redirect,
      cancel_url: cancel,
    };
    if (user.email) payload.customer_email = user.email;

    // Coinbase Commerce charge
    const resp = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CC-Api-Key': apiKey,
        'X-CC-Version': '2018-03-22',
      },
      body: JSON.stringify(payload),
    });

    let json: any = null;
    try { json = await resp.json(); } catch { json = null; }

    if (!resp.ok) {
      // log the error for visibility
      try {
        await sb.from('webhook_logs').insert({
          source: 'coinbase',
          event: 'create_failed',
          http_status: resp.status,
          payload: { req: payload, res: json, depositId: dep.id },
        });
      } catch {}

      await sb.from('deposits').update({
        status: 'failed'
      }).eq('id', dep.id);

      return send(res, 400, { error: json?.error?.message || 'coinbase_failed', status: resp.status });
    }

    await sb.from('deposits').update({
      provider_id: json?.data?.id || null
    }).eq('id', dep.id);

    try {
      await sb.from('webhook_logs').insert({
        source: 'coinbase',
        event: 'create_ok',
        http_status: 200,
        payload: {
          depositId: dep.id,
          provider_id: json?.data?.id,
          provider_code: json?.data?.code,
          hosted_url: json?.data?.hosted_url,
          amount_cents: cents
        },
      });
    } catch {}

    return send(res, 200, {
      url: json?.data?.hosted_url,
      deposit_id: dep.id,
      amount_cents: cents,
      method: 'coinbase',
    });
  } catch (e: any) {
    try {
      await sb.from('webhook_logs').insert({
        source: 'coinbase',
        event: 'create_exception',
        http_status: 500,
        payload: { error: String(e?.message || e) },
      });
    } catch {}
    return send(res, 500, { error: e?.message || String(e) });
  }
}