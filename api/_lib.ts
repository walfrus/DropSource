// api/_lib.ts
import type { NextApiRequest } from 'next';

/** --- SMM panel proxy helpers --- */
const PANEL_URL = process.env.SMM_API_URL!;
const PANEL_KEY = process.env.SMM_API_KEY!;

export async function callPanel(
  action: 'services'|'add'|'status'|'balance'|'refill'|'cancel'|'ping',
  payload: Record<string, any> = {}
) {
  if (!PANEL_URL || !PANEL_KEY) throw new Error('panel env not set');

  const body = new URLSearchParams({
    key: PANEL_KEY,
    action,
    ...Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])),
  });

  const r = await fetch(PANEL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  // Many panels return text/HTML on error; try JSON first then fall back
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    if (!r.ok) throw new Error(`panel ${action} failed: ${text.slice(0, 200)}`);
    return text;
  }
}

export function mapService(s: any) {
  // Normalize a panel service into what your UI expects
  return {
    id: s.service ?? s.id ?? s.ID,
    name: s.name ?? s.title,
    price_per_1k: Number(s.rate ?? s.price ?? s.price_per_k ?? 0),
    min: Number(s.min ?? s.min_quantity ?? 0),
    max: Number(s.max ?? s.max_quantity ?? 0),
    category: s.category ?? s.cat,
    type: s.type ?? s.mode ?? 'Default',
    flags: {
      refill: !!(s.refill || s.refill_available),
      fast: /fast/i.test(`${s.name} ${s.description || ''}`),
      real: /real/i.test(`${s.name} ${s.description || ''}`),
      dripfed: /drip/i.test(`${s.name} ${s.description || ''}`),
    },
    raw: s, // keep for variants
  };
}

/** --- Wallet helpers (Supabase) --- */
import { sb } from '../lib/db';

export type UserLite = { id: string; email: string | null };

export async function ensureUserAndWallet(user: UserLite) {
  // upsert user
  await sb.from('users')
    .upsert({ id: user.id, email: user.email ?? null })
    .select('id')
    .single()
    .catch(() => null);

  // ensure wallet
  const { data: rows } = await sb.from('wallets')
    .select('id')
    .eq('user_id', user.id)
    .limit(1);
  if (!rows || rows.length === 0) {
    await sb.from('wallets').insert({
      user_id: user.id,
      balance_cents: 0,
      currency: 'usd',
    });
  }
}

/** --- Auth helper (header-based for now) --- */
export function getUser(req: NextApiRequest): UserLite | null {
  const id = (req.headers['x-user-id'] as string) || '';
  const email = (req.headers['x-user-email'] as string) || '';
  return id ? { id, email: email || null } : null;
}