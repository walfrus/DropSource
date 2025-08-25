// lib/db.ts
import { createClient } from '@supabase/supabase-js';

export const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server-side use only
  { auth: { persistSession: false } }
);