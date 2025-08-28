// lib/db.ts
// Central Supabase client (service role) used by API routes.
// NOTE: other files import this as '../../lib/db.js' — that's correct for ESM on Vercel,
// because this .ts compiles to db.js at build time.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL as string | undefined;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined;

if (!url || !key) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

export const sb: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});