// lib/auth.ts
import { NextApiRequest } from 'next';

export function getUser(req: NextApiRequest) {
  // TEMP: until real auth, pass these headers from the client
  const id = (req.headers['x-user-id'] as string) || '';
  const email = (req.headers['x-user-email'] as string) || '';
  return id ? { id, email } : null;
}