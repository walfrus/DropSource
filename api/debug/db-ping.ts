import { sb } from '../../lib/db.js';

export default async function handler(req: any, res: any) {
  try {
    const { error } = await sb.from('webhook_logs').insert({
      src: 'debug',
      note: 'db-ping',
      payload: { now: new Date().toISOString() }
    });
    if (error) throw error;
    res.statusCode = 200; res.end('ok');
  } catch (e: any) {
    res.statusCode = 500; res.end(String(e?.message || e));
  }
}