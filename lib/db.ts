// /lib/db.ts — server-only Supabase client
import { createClient } from '@supabase/supabase-js';

// Hard guard: never import this in the browser (prevents accidental bundling)
if (typeof window !== 'undefined') {
  throw new Error('Do not import lib/db on the client (service role key)');
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
}

// Reuse a single instance across hot reloads (dev) / Lambda cold starts (prod)
// @ts-ignore
const globalAny = global as any;
export const sb =
  globalAny.__SB_SERVER__ ||
  (globalAny.__SB_SERVER__ = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'X-Client-Info': 'dropsource-server' } },
  }));