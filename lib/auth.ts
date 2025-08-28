// /lib/auth.ts
// Very simple header-based auth with sensible fallbacks.
// Caller should send:  x-user-id, x-user-email
// We also accept query (?uid=&email=) and cookies (uid=, email=) as fallback.
// Extras: supports `req.cookies` (Next/Vercel style) and an optional `x-user: "<id>:<email>"`
// Returns `{ id, email }` where `email` is `string | null`.

export function getUser(req: any): { id: string; email: string | null } | null {
  const hdr = (name: string): string => {
    const h = (req?.headers ?? {}) as Record<string, unknown>;
    // normalize header key lookups across runtimes (mostly lowercase on Vercel)
    const tryKeys = [name, name.toLowerCase(), name.toUpperCase()];
    for (const k of tryKeys) {
      const v = h[k];
      if (v == null) continue;
      if (Array.isArray(v)) return String(v[0] ?? '');
      return String(v);
    }
    return '';
  };

  const q = (key: string): string => {
    // 1) Prefer framework-provided req.query (Next/Vercel, Express adapters)
    const qsrc = req?.query as Record<string, unknown> | undefined;
    if (qsrc && typeof qsrc === 'object') {
      const k = String(key);
      const raw = (qsrc[k] ?? qsrc[k.toLowerCase()]) as unknown;
      const val = Array.isArray(raw) ? (raw[0] as unknown) : raw;
      if (typeof val === 'string' && val) return val;
      if (val != null) return String(val);
    }
    // 2) Fallback: parse from raw URL (pure Node runtimes)
    try {
      const url = new URL(req?.url || '', 'http://localhost');
      return url.searchParams.get(key) || '';
    } catch {
      return '';
    }
  };

  // merge cookies from header and any framework-provided req.cookies
  const parseCookieHeader = (raw: string): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!raw) return out;
    for (const part of String(raw).split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
    return out;
  };

  const cookiesFromHeader = parseCookieHeader(hdr('cookie'));
  const cookiesFromRuntime = (req?.cookies && typeof req.cookies === 'object') ? (req.cookies as Record<string, string>) : {};
  const cookies: Record<string, string> = { ...cookiesFromHeader, ...cookiesFromRuntime };

  // optional combo header: x-user as JSON {"id":"...","email":"..."} OR "<id>:<email>" / "<id>|<email>"
  let xuId = '', xuEmail = '';
  const xUser = hdr('x-user');
  if (xUser) {
    const s = String(xUser).trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === 'object') {
          xuId = String((obj as any).id ?? '').trim();
          xuEmail = String((obj as any).email ?? '').trim();
        }
      } catch {
        // fall through to split parsing below
      }
    }
    if (!xuId && !xuEmail) {
      const parts = s.split(/[|:,]/);
      xuId = (parts[0] ?? '').trim();
      xuEmail = (parts[1] ?? '').trim();
    }
  }

  const rawId =
    hdr('x-user-id') ||
    q('uid') || q('user') ||
    cookies['uid'] || cookies['user'] ||
    xuId || '';

  const rawEmail =
    hdr('x-user-email') ||
    q('email') || cookies['email'] ||
    xuEmail || '';

  const id = sanitizeId(rawId);
  const emailSan = sanitizeEmail(rawEmail);
  const email: string | null = emailSan || null;

  return id ? { id, email } : null;
}

function sanitizeId(v: string): string {
  if (!v) return '';
  const s = String(v).trim();
  // allow letters, numbers, underscore, dash, dot, colon
  const cleaned = s.replace(/[^A-Za-z0-9_.:-]/g, '');
  return cleaned.slice(0, 120);
}

function sanitizeEmail(v: string): string {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  // very light filtering to keep things tame in logs/DB
  const cleaned = s.replace(/[^a-z0-9+_.@-]/g, '');
  return cleaned.slice(0, 190);
}