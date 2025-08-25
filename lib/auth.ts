// lib/auth.ts
import type { NextApiRequest } from 'next';

export function getUser(req: NextApiRequest) {
  // TEMP header auth while you wire the real thing
  const id = (req.headers['x-user-id'] as string) || '';
  const email = (req.headers['x-user-email'] as string) || '';
  return id ? { id, email } : null;
}