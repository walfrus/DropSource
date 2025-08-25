// api/_lib.ts

import { sb } from "../lib/db";

/** User shape for wallet init */
export type UserLite = { id: string; email?: string | null };

/**
 * Ensure the user exists in `users` and has a wallet row.
 */
export async function ensureUserAndWallet(user: UserLite) {
  try {
    await sb.from("users")
      .upsert({ id: user.id, email: user.email ?? null })
      .select()
      .single();
  } catch {
    // already exists
  }

  const { data: rows } = await sb
    .from("wallets")
    .select("id")
    .eq("user_id", user.id)
    .limit(1);

  if (!rows || rows.length === 0) {
    await sb.from("wallets").insert({
      user_id: user.id,
      balance_cents: 0,
      currency: "usd",
    });
  }
}

/**
 * Generic helper to call your SMM panel API.
 * Defaults to POST + urlencoded (most panels).
 */
export async function callPanel(
  action: string,
  extra: Record<string, string | number | boolean> = {}
) {
  const url = process.env.SMM_API_URL;
  const key = process.env.SMM_API_KEY;

  if (!url || !key) {
    throw new Error("SMM_API_URL or SMM_API_KEY missing");
  }

  const body = new URLSearchParams({
    key,
    action,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Panel returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Normalize a raw service row into consistent shape.
 */
export function mapService(s: any) {
  const price = Number(s.rate ?? s.price ?? 0);

  return {
    id: s.service ?? s.id,
    name: String(s.name ?? s.service ?? "Unnamed"),
    category: String(s.category ?? "Other"),
    price_per_1k: isNaN(price) ? 0 : price,
    min: Number(s.min ?? s.min_order ?? 0),
    max: Number(s.max ?? s.max_order ?? 0),
    dripfeed: Boolean(s.dripfeed ?? s.drip ?? false),
    refill: Boolean(s.refill ?? false),
    _raw: s,
  };
}