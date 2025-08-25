import { sb } from './db';
export type UserLite = { id: string; email?: string | null };
export type SB = typeof sb;

export async function ensureUserAndWallet(db: SB, user: UserLite): Promise<void> {
  try {
    await db.from('users')
      .upsert({ id: user.id, email: user.email ?? null })
      .select()
      .single();
  } catch {}

  const { data: rows } = await db
    .from('wallets')
    .select('id')
    .eq('user_id', user.id)
    .limit(1);

  if (!rows || rows.length === 0) {
    await db.from('wallets').insert({
      user_id: user.id,
      balance_cents: 0,
      currency: 'usd',
    });
  }
}