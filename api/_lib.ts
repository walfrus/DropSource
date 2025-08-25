// api/_lib.ts

// super light types so TS chills out
export type UserLite = {
  id: string;
  email?: string | null;
};

// not pulling full supabase types—keep loose
export type SB = any;

/**
 * Ensure the user exists in `users` and has a `wallets` row.
 * Safe to call on every request.
 */
export async function ensureUserAndWallet(sb: SB, user: UserLite): Promise<void> {
  // upsert the user
  try {
    await sb
      .from('users')
      .upsert({ id: user.id, email: user.email ?? null })
      .select()
      .single();
  } catch {
    // if row exists already, ignore
  }

  // does a wallet exist?
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