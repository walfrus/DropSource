import { readJsonBody } from '../../lib/smm.js';
import { getUser } from '../../lib/auth.js';
import { sb } from '../../lib/db.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

  const user = getUser(req);
  if (!user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const service = String(body?.service_code || '').trim();
    const target = String(body?.target_url || '').trim();
    const qty = Number(body?.quantity || 0);

    if (!service || !target || !Number.isFinite(qty) || qty <= 0) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'missing/invalid inputs' }));
      return;
    }

    const { data, error } = await sb.rpc('debit_and_create_order', {
      p_user_id: user.id,
      p_service_code: service,
      p_target_url: target,
      p_quantity: qty,
    });

    if (error) {
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('insufficient_funds')) {
        res.statusCode = 402; // payment required-ish
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'insufficient_funds' }));
        return;
      }
      if (msg.includes('service_not_found')) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'service_not_found' }));
        return;
      }
      if (msg.includes('invalid_quantity')) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_quantity' }));
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'server_error' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      order_id: data?.[0]?.order_id,
      new_balance_cents: data?.[0]?.new_balance_cents
    }));
  } catch (e: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
}