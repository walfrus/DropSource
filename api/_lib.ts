// api/_lib.ts
// tiny helper to make sure the user + wallet rows exist
type UserLite = { id: string; email?: string | null };
type SB = any; // keep loose for now to avoid pulling supabase types

export async function ensureUserAndWallet(sb: SB, user: UserLite) {
  // upsert user row (id is PK in your schema)
  try {
    await sb.from('users')
      .upsert({ id: user.id, email: user.email ?? null })
      .select()
      .single();
  } catch { /* ignore if already exists */ }

  // does wallet exist?
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