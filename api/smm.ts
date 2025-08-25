import { callPanel, mapService } from '../lib/smm.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') { res.statusCode = 405; res.end('method_not_allowed'); return; }

  try {
    const raw = await callPanel('services');
    if (!Array.isArray(raw)) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'unexpected upstream payload', raw }));
      return;
    }
    const mapped = raw.map(mapService).filter(x => x && x.id)
      .sort((a, b) => (a.price || 0) - (b.price || 0));

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mapped));
  } catch (err: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}