import { sb } from '../../lib/db.js';

export default async function handler(req: any, res: any) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  if (req.method !== 'GET') {
    res.statusCode = 405; res.setHeader('Allow', 'GET'); res.end('method_not_allowed');
    return;
  }

  try {
    const now = new Date().toISOString();
    const { error } = await sb.from('webhook_logs').insert({
      source: 'debug',
      event: 'db-ping',
      http_status: 200,
      payload: { now }
    });
    if (error) throw error;
    res.statusCode = 200; res.end('ok');
  } catch (e: any) {
    res.statusCode = 500; res.end(String(e?.message || e));
  }
}