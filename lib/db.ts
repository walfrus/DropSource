// /lib/db.ts
// Server-side Supabase client (service role).
// Other files import:  import { sb } from '../../lib/db.js'
// NOTE: No route logic belongs here.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_KEY ||
  '';

// Singleton so Vercel lambdas reuse the same instance between invocations.
let _sb: SupabaseClient | null = null;

function makeClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Keep a readable error in logs – do NOT throw here to avoid 500 spam.
    console.warn('[db] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: { schema: 'public' },
    global: {
      headers: { 'X-Client-Info': 'dropsource/1.0 server' },
    },
  });
}

// Export a shared client for normal use.
export const sb: SupabaseClient = (_sb ||= makeClient());

// Optionally get a fresh isolated client (rarely needed).
export function newAdminClient(): SupabaseClient {
  return makeClient();
}