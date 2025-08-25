// api/smm.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { sb, getUser, ensureUserAndWallet } from './_lib';

// ---- config pulled from env ----
const PANEL_URL = process.env.SMM_API_URL!;
const PANEL_KEY = process.env.SMM_API_KEY!;

function bad(res: NextApiResponse, code: number, msg: string) {
  return res.status(code).json({ error: msg });
}

// Minimal helper to call typical SMM panels (POST form-encoded).
async function callPanel<T = any>(action: string, extra: Record<string, any> = {}): Promise<T> {
  const form = new URLSearchParams({ key: PANEL_KEY, action, ...Object.fromEntries(
    Object.entries(extra).map(([k, v]) => [k, String(v)])
  )});

  const r = await fetch(PANEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const text = await r.text();

  // Panels sometimes return HTML when rate-limited or blocked—guard it.
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON (${r.status}): ${text.slice(0, 180)}…`);
  }
}

// normalize one service into the shape the UI expects
function mapService(s: any) {
  // common fields across most panels; fallback defensively
  const pricePer1k =
    s.price_per_1k ??
    s.rate ??
    s.price ??
    (typeof s.rate === 'string' ? parseFloat(s.rate) : undefined);

  // tags: derive a few quick labels from text
  const raw = `${s.name ?? ''} ${s.description ?? ''}`.toLowerCase();
  const tags: string[] = [];
  if (raw.includes('drip')) tags.push('Dripped');
  if (raw.includes('refill')) tags.push('Refill');
  if (raw.includes('fast') || raw.includes('speed')) tags.push('Fast');
  // pull some geo hints
  const geos = ['usa','us','india','brazil','mexico','indonesia','korea','spain','france','italy','turkey','russia'];
  geos.forEach(g => { if (raw.includes(g)) tags.push(g.toUpperCase()); });

  return {
    id: String(s.service ?? s.id ?? ''),
    name: String(s.name ?? 'Service'),
    category: String(s.category ?? s.type ?? 'Other'),
    price_per_1k: typeof pricePer1k === 'number' ? pricePer1k : (parseFloat(pricePer1k) || 0),
    min: Number(s.min ?? s.min_amount ?? 0),
    max: Number(s.max ?? s.max_amount ?? 0),
    type: String(s.type ?? 'Default'),
    raw: s,              // keep original for detail view
    tags,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = String(req.query.action ?? 'services');

  try {
    switch (action) {
      case 'services': {
        if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');

        const raw = await callPanel<any[]>('services');
        if (!Array.isArray(raw)) {
          return bad(res, 502, 'unexpected upstream payload');
        }
        const mapped = raw.map(mapService);
        return res.json(mapped);
      }

      case 'wallet_get': {
        if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');

        const user = getUser(req);
        if (!user) return bad(res, 401, 'unauthorized');

        await ensureUserAndWallet(user);

        const { data: w, error } = await sb
          .from('wallets')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (error) return bad(res, 400, error.message);
        return res.json({ balance_cents: w?.balance_cents ?? 0, currency: w?.currency ?? 'usd' });
      }

      // ---- stubs you can fill later if you want everything in one route ----
      // case 'order': { /* place an order with the panel */ }
      // case 'cancel': { /* cancel order */ }
      // case 'refill': { /* refill order */ }

      default:
        return bad(res, 404, `unknown action: ${action}`);
    }
  } catch (err: any) {
    console.error('smm route error:', err?.message || err);
    return bad(res, 500, 'internal');
  }
}