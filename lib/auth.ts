// /lib/auth.ts

// Very simple "auth" via headers you pass from the client for now.
// Caller should send:  x-user-id, x-user-email
export function getUser(req: any): { id: string; email: string } | null {
  const id = (req.headers?.['x-user-id'] as string) || '';
  const email = (req.headers?.['x-user-email'] as string) || '';
  return id ? { id, email } : null;
}