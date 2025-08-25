// lib/smm.ts
import * as crypto from 'crypto';

export async function callPanel(
  action: string,
  extra: Record<string, string | number> = {}
) {
  const url = process.env.SMM_API_URL || '';
  const key = process.env.SMM_API_KEY || '';
  if (!url || !key) throw new Error('Missing SMM_API_URL or SMM_API_KEY');

  const body = new URLSearchParams({ key, action });
  for (const [k, v] of Object.entries(extra)) body.append(k, String(v));

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(text || `panel ${r.status}`); }
}

export function mapService(s: any) {
  const price1k = Number(s.rate ?? s.price ?? s.price_per_1k ?? 0);
  const name = String(s.name ?? '').toLowerCase();
  const tags: string[] = [];
  const GEO = ['usa','uk','korea','india','brazil','mexico','turkey','russia','indonesia','italy','france','germany','uae','saudi','japan','spain','canada','global','worldwide'];
  for (const g of GEO) if (name.includes(g)) tags.push(g.toUpperCase());
  return {
    id: String(s.service ?? s.id ?? ''),
    name: String(s.name ?? 'Service'),
    category: String(s.category ?? ''),
    price: price1k,
    min: Number(s.min ?? 0),
    max: Number(s.max ?? 0),
    type: String(s.type ?? 'Default'),
    flags: {
      dripfeed: Boolean(s.dripfeed ?? false),
      refill: Boolean(s.refill ?? false),
      cancel: Boolean(s.cancel ?? false),
      real: /real/i.test(String(s.description ?? s.note ?? s.name ?? '')),
      fast: /fast|speed/i.test(String(s.name ?? '')),
    },
    tags
  };
}

export async function ensureUserAndWallet(sb: any, user: { id: string; email?: string | null }) {
  await sb.from('users').upsert({ id: user.id, email: user.email ?? null }).select('id').single();
  const { data: rows } = await sb.from('wallets').select('id').eq('user_id', user.id).limit(1);
  if (!rows || rows.length === 0) {
    await sb.from('wallets').insert({ user_id: user.id, balance_cents: 0, currency: 'usd' });
  }
}

export function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req: any) {
  const buf = await readRawBody(req);
  if (!buf?.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

export { crypto };