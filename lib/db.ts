// lib/db.ts
import { createClient } from '@supabase/supabase-js';

export const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,   // public ok
  process.env.SUPABASE_SERVICE_ROLE_KEY!,  // SERVER ONLY
  { auth: { persistSession: false } }
);