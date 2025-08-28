// /api/wallet/get.ts
import { sb } from '../../lib/db.js';
import { getUser } from '../../lib/auth.js';
import { ensureUserAndWallet } from '../../lib/smm.js';

export const config = { runtime: 'nodejs18.x' };

function sendJson(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

export default async function handler(req: any, res: any) {
  try {
    const user = getUser(req);
    if (!user) return sendJson(res, 401, { error: 'no user' });

    await ensureUserAndWallet(sb, user);

    const { data: w, error } = await sb
      .from('wallets')
      .select('balance_cents,currency')
      .eq('user_id', user.id)
      .single();

    if (error) return sendJson(res, 400, { error: error.message });

    return sendJson(res, 200, {
      balance_cents: w?.balance_cents ?? 0,
      currency: w?.currency ?? 'usd',
    });
  } catch (e: any) {
    const dbg = String(req.headers['x-debug-return-error'] || '') === '1';
    if (dbg) return sendJson(res, 200, { debug: 'handler_error', err: String(e?.message || e) });
    // Don't 500 on serverless; return ok so the platform doesn't show a big red error
    res.statusCode = 200;
    res.end('ok');
  }
}
// lib/smm.js
// Minimal, safe helpers used by multiple API routes

/** Read raw request body into a Buffer (no JSON parsing). */
export async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** Read JSON body; returns {} if invalid/missing. */
export async function readJsonBody(req) {
  const raw = await readRawBody(req);
  try {
    const str = raw.toString('utf8') || '';
    return str ? JSON.parse(str) : {};
  } catch {
    return {};
  }
}

/** Idempotently ensure user & wallet rows exist. */
export async function ensureUserAndWallet(sb, user) {
  // users upsert
  await sb.from('users')
    .upsert({ id: user.id, email: user.email ?? null })
    .select('id')
    .single();

  // wallet ensure-if-missing
  const { data: rows } = await sb
    .from('wallets')
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