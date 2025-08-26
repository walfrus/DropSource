// /api/_lib.ts

import * as crypto from 'crypto';
export { crypto };

// --- SMM PANEL --------------------------------------------------------------

/**
 * Call your SMM panel. Env support (any of these work):
 *   SMM_API_URL / PANEL_API_URL / SMM_API
 *   SMM_API_KEY / PANEL_API_KEY / SMM_KEY
 * `action` is the panel action (e.g. 'services').
 * `extra` merges any additional form fields.
 */
export async function callPanel(
  action: string,
  extra: Record<string, string | number> = {}
): Promise<any> {
  const url = process.env.SMM_API_URL || process.env.PANEL_API_URL || process.env.SMM_API || '';
  const key = process.env.SMM_API_KEY || process.env.PANEL_API_KEY || process.env.SMM_KEY || '';
  if (!url || !key) throw new Error('Missing SMM_API_URL/PANEL_API_URL or SMM_API_KEY/PANEL_API_KEY');

  const body = new URLSearchParams({ key, action });
  for (const [k, v] of Object.entries(extra)) body.append(k, String(v));

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/plain, */*'
    },
    body
  });

  // Some panels return HTML on errors—try JSON first, fall back to text
  const text = await r.text();
  try {
    const json = JSON.parse(text);
    // many panels return `{ error: ".." }` with 200; surface that
    if (json && typeof json === 'object' && json.error) {
      throw new Error(String(json.error));
    }
    // also surface HTTP errors even if JSON has no explicit `error`
    if (!r.ok) {
      throw new Error(`panel ${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
    }
    return json;
  } catch (e) {
    // not JSON; surface status + body
    if (!r.ok) throw new Error(text || `panel ${r.status}`);
    // if 200 but non-JSON, still throw so callers see the raw response
    throw new Error(text || 'panel returned non-JSON');
  }
}

/** Shape incoming panel service into something UI-friendly. */
export function mapService(s: any) {
  // Common SMM keys with fallbacks
  const price1k = Number(
    s.rate ?? s.price ?? s.price_per_1k ?? s.pricePer1000 ?? s.price_per_1000 ?? 0
  );

  // name sanitization (hide upstream branding like smmgoal)
  const rawName = String(s.name ?? 'Service');
  const name = rawName
    .replace(/smmgoal/gi, 'DropSource')
    .replace(/\[(?:smmgoal|dropsource)\]\s*[—-]\s*/gi, '')
    .trim();

  // tags / flags inferred
  const tags: string[] = [];
  const rawTags = [
    ...(Array.isArray(s.tags) ? s.tags : []),
    ...(typeof s.category === 'string' ? [s.category] : []),
    ...(typeof s.description === 'string' ? [s.description] : []),
  ].filter(Boolean);

  for (const t of rawTags) tags.push(String(t));

  // try detecting geos fast
  const lower = `${name} ${String(s.category ?? '')}`.toLowerCase();
  const GEO = ['usa','uk','korea','india','brazil','mexico','turkey','russia','indonesia','italy','france','germany','uae','saudi','japan','spain','canada','global','worldwide'];
  for (const g of GEO) if (lower.includes(g)) tags.push(g.toUpperCase());

  const min = Number(s.min ?? s.min_order ?? 0);
  const max = Number(s.max ?? s.max_order ?? 0);

  return {
    id: String(s.service ?? s.id ?? ''),
    name,
    category: String(s.category ?? ''),
    description: String(s.description ?? s.note ?? ''),
    price: price1k,               // kept for BC
    price_per_1k: price1k,        // preferred by UI
    min,
    max,
    type: String(s.type ?? s.kind ?? 'Default'),
    flags: {
      dripfeed: Boolean(s.dripfeed ?? s.drip ?? false),
      refill: Boolean(s.refill ?? s.refill_time ?? false),
      cancel: Boolean(s.cancel ?? false),
      real: /real/i.test(String(s.description ?? s.note ?? '')) || /real/i.test(rawName),
      fast: /fast|instant|speed/i.test(rawName),
    },
    tags
  };
}

// --- USERS & WALLETS --------------------------------------------------------

/** Make sure user row and wallet row exist. */
export async function ensureUserAndWallet(sb: any, user: { id: string; email?: string | null }) {
  // upsert user (idempotent)
  await sb.from('users')
    .upsert({ id: user.id, email: user.email ?? null })
    .select('id')
    .single();

  // ensure wallet exists
  const q = await sb.from('wallets')
    .select('id')
    .eq('user_id', user.id)
    .limit(1);

  const rows = (q as any)?.data as any[] | null;
  if (!rows || rows.length === 0) {
    try {
      await sb.from('wallets').insert({
        user_id: user.id,
        balance_cents: 0,
        currency: 'usd'
      });
    } catch {
      // ignore conflict/duplicate insert races (409)
    }
  }
}

// --- RAW BODY HELPERS (for webhooks) ---------------------------------------

/** Read raw request body as Buffer (for HMAC verification). */
export function readRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Read JSON body (for normal POST routes). */
export async function readJsonBody(req: any) {
  const buf = await readRawBody(req);
  if (!buf?.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}