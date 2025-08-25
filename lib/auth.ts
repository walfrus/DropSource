// lib/auth.ts
import type { NextApiRequest } from 'next';
export function getUser(req: NextApiRequest) {
  const id = (req.headers['x-user-id'] as string) || '';
  const email = (req.headers['x-user-email'] as string) || '';
  return id ? { id, email: email || null } : null;
}