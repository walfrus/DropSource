import { readJsonBody, ensureUserAndWallet } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

// ...rest of file unchanged from my previous message...

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
      user_id: user.id, method: 'coinbase', amount_cents: cents, status: 'pending'
    }).select('*').single();
    if (error) throw error;

    const apiKey = process.env.COINBASE_COMMERCE_API_KEY || '';
    const redirect = `${process.env.PUBLIC_URL}/balance?ok=1`;
    const cancel = `${process.env.PUBLIC_URL}/balance?canceled=1`;

    const r = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': apiKey,
        'X-CC-Version': '2018-03-22'
      },
      body: JSON.stringify({
        name: 'DropSource Credits',
        pricing_type: 'fixed_price',
        local_price: { amount: (cents / 100).toFixed(2), currency: 'USD' },
        metadata: { userId: user.id, depositId: dep.id },
        redirect_url: redirect,
        cancel_url: cancel
      })
    });

    const json = await r.json();
    if (!r.ok) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: json?.error?.message || 'coinbase failed' }));
      return;
    }

    await sb.from('deposits').update({ provider_id: json?.data?.id || null }).eq('id', dep.id);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: json?.data?.hosted_url }));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}