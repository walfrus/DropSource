// lib/smm.ts
import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// normalize booleans from panels: 1/0, "1"/"0", yes/no/true/false
function toBool(v: any): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return false;
  const t = String(v).trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'y';
}

// -------- Panel helpers --------
export async function callPanel(
  action: string,
  extra: Record<string, string | number> = {}
) {
  // Support both env conventions (and common aliases)
  const url = process.env.PANEL_API_URL || process.env.SMM_API_URL || process.env.SMM_API || '';
  const key = process.env.PANEL_API_KEY || process.env.SMM_API_KEY || process.env.SMM_KEY || '';
  if (!url || !key) throw new Error('Missing PANEL_API_URL/SMM_API or PANEL_API_KEY/SMM_API_KEY');

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

  const text = await r.text();
  try {
    const json = JSON.parse(text);
    // many panels return `{ error: "..." }` with 200
    if (json && typeof json === 'object' && 'error' in json && json.error) {
      if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${JSON.stringify(json)}`);
      return json; // bubble error up so caller can show it
    }
    if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${JSON.stringify(json).slice(0, 400)}`);
    return json;
  } catch {
    if (!r.ok) throw new Error(`Panel ${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
    // Rare non-JSON success; return shaped object for UI/debug
    return { error: 'Non-JSON response from panel', body: text.slice(0, 500) } as const;
  }
}

export function mapService(s: any) {
  const price1k = Number(
    s.rate ?? s.price ?? s.price_per_1k ?? s.pricePer1000 ?? s.price_per_1000 ?? 0
  );

  const rawName = String(s.name ?? 'Service');
  // scrub upstream branding/footprints
  const cleanName = rawName
    .replace(/smmgoal/gi, 'DropSource')
    .replace(/\[(?:smmgoal|dropsource)\]\s*[—-]\s*/gi, '')
    .trim();

  // collect geo-ish tags from name/category
  const tags: string[] = [];
  const search = `${cleanName} ${String(s.category ?? '')}`.toLowerCase();
  const GEO = ['usa','uk','korea','india','brazil','mexico','turkey','russia','indonesia','italy','france','germany','uae','saudi','japan','spain','canada','global','worldwide'];
  for (const g of GEO) if (search.includes(g)) tags.push(g.toUpperCase());

  return {
    id: String(s.service ?? s.id ?? ''),
    name: cleanName,
    category: String(s.category ?? ''),
    price: price1k,
    price_per_1k: price1k,
    min: Number(s.min ?? s.min_order ?? 0),
    max: Number(s.max ?? s.max_order ?? 0),
    type: String(s.type ?? 'Default'),
    dripfeed: toBool(s.dripfeed ?? s.drip ?? false),
    refill: toBool(s.refill ?? s.refill_time ?? false),
    cancel: toBool(s.cancel ?? false),
    flags: {
      dripfeed: toBool(s.dripfeed ?? s.drip ?? false),
      refill: toBool(s.refill ?? s.refill_time ?? false),
      cancel: toBool(s.cancel ?? false),
      real: /real/i.test(String(s.description ?? s.note ?? rawName)),
      fast: /fast|instant|speed/i.test(rawName),
    },
    tags
  };
}

// -------- User + Wallet helpers --------
export async function ensureUserAndWallet(
  sb: SupabaseClient,
  user: { id: string; email?: string | null }
) {
  // make sure there's a users row (idempotent)
  await sb.from('users').upsert(
    { id: user.id, email: user.email ?? null },
    { onConflict: 'id' }
  );

  // ensure wallet without throwing if it already exists
  const { error } = await sb.from('wallets').upsert(
    { user_id: user.id, balance_cents: 0, currency: 'usd' },
    { onConflict: 'user_id' }
  );

  // ignore typical duplicate errors, surface others
  if (error && (error as any).code !== '23505') {
    throw error;
  }
}

// Credit a deposit by Square payment_link_id (id saved as deposits.provider_id)
export async function creditDepositByPaymentLinkId(
  sb: SupabaseClient,
  paymentLinkId: string
): Promise<{
  ok: boolean;
  error?: string;
  already?: boolean;
  user_id?: string;
  deposit_id?: string;
  amount_cents?: number;
}> {
  if (!paymentLinkId) return { ok: false, error: 'missing paymentLinkId' };

  // Determine the "success" status your DB allows (env overrides), plus synonyms
  const successStatus = (process.env.DEPOSIT_SUCCESS_STATUS || 'confirmed').toLowerCase();
  const PAID_STATUSES = new Set(['paid', 'completed', 'confirmed', 'succeeded', 'success', 'ok', 'done', successStatus]);

  // 1) fetch the deposit row linked to this Square payment link id
  const depSel = await sb.from('deposits').select('*').eq('provider_id', paymentLinkId).single();
  const dep = depSel.data as any;
  if (!dep) return { ok: false, error: 'deposit not found' };

  // If it's already in a finalized/paid state, be idempotent
  const current = String(dep.status || '').toLowerCase();
  if (PAID_STATUSES.has(current)) {
    return {
      ok: true,
      already: true,
      user_id: dep.user_id,
      deposit_id: dep.id,
      amount_cents: dep.amount_cents
    };
  }

  // 2) mark deposit as successful using the allowed status
  const upd = await sb.from('deposits').update({ status: successStatus }).eq('id', dep.id);
  if (upd.error) return { ok: false, error: upd.error.message };

  // 3) ensure wallet exists and credit the amount
  const wSel = await sb.from('wallets').select('balance_cents').eq('user_id', dep.user_id).single();
  if (!wSel.data) {
    try {
      await sb.from('wallets').insert({ user_id: dep.user_id, balance_cents: 0, currency: 'usd' });
    } catch {
      // ignore create race
    }
  }
  const cur = Number(wSel.data?.balance_cents ?? 0);
  const next = cur + Number(dep.amount_cents || 0);

  const wUpd = await sb.from('wallets').update({ balance_cents: next }).eq('user_id', dep.user_id);
  if (wUpd.error) return { ok: false, error: wUpd.error.message };

  return { ok: true, user_id: dep.user_id, deposit_id: dep.id, amount_cents: dep.amount_cents };
}

// Best-effort webhook logger (won't throw)
export async function logWebhook(
  sb: SupabaseClient,
  source: string,
  event: string,
  meta?: any,
  raw?: any
) {
  try {
    await sb.from('webhook_logs').insert({
      source,
      event,
      http_status: 200,
      payload: { meta: meta ?? null, raw: raw ?? null }
    });
  } catch {
    // no-op
  }
}

// -------- Body utils --------
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