// @ts-nocheck
// /api/wallet/get.ts — REST-only (no supabase-js)

function send(res: any, code: number, obj: any) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'x-user-id, x-user-email');
  res.end(JSON.stringify(obj));
}

function getUser(req: any) {
  const id = String(req.headers?.['x-user-id'] || '').trim();
  const emailRaw = req.headers?.['x-user-email'];
  const email = typeof emailRaw === 'string' ? emailRaw.trim() : null;
  return id ? { id, email } : null;
}

function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function sfetch(path: string, init: any = {}) {
  const base = envOrThrow('SUPABASE_URL');
  const key = envOrThrow('SUPABASE_SERVICE_ROLE_KEY');
  const url = `${base.replace(/\/$/, '')}/rest/v1${path}`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...init.headers,
  } as Record<string, string>;
  const F = (globalThis as any).fetch || (await import('node-fetch')).default;
  const res = await F(url, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json, text };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { error: 'method_not_allowed' });
  }

  const debugEcho = String(req.headers?.['x-debug-return-error'] || '') === '1';

  try {
    const user = getUser(req);
    if (!user) return send(res, 401, { error: 'no user' });

    // 1) Upsert user row (idempotent)
    await sfetch('/users?on_conflict=id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: user.id, email: user.email ?? null }),
    });

    // 2) Read wallet
    let { res: r1, json: j1 } = await sfetch(`/wallets?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,balance_cents,currency&limit=1`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    // If not present, create then re-read
    if (!Array.isArray(j1) || j1.length === 0) {
      await sfetch('/wallets?on_conflict=user_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ user_id: user.id, balance_cents: 0, currency: 'usd' }),
      });
      const again = await sfetch(`/wallets?user_id=eq.${encodeURIComponent(user.id)}&select=user_id,balance_cents,currency&limit=1`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      r1 = again.res; j1 = again.json;
    }

    const row = Array.isArray(j1) ? j1[0] : null;
    const centsNum = Number(row?.balance_cents ?? 0);
    const cents = Number.isFinite(centsNum) ? Math.max(0, Math.trunc(centsNum)) : 0;

    return send(res, 200, {
      balance_cents: cents,
      currency: String(row?.currency ?? 'usd').toLowerCase(),
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (debugEcho) return send(res, 200, { debug: 'handler_error', err: msg });
    return send(res, 200, { error: 'server_error' });
  }
}

export const config = { runtime: 'nodejs' };