// api/smm.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { callPanel, mapService } from './_lib';

function bad(res: NextApiResponse, code: number, msg: string) {
  return res.status(code).json({ error: msg });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const action = (req.query.action as string || '').toLowerCase();

  try {
    switch (action) {
      case 'services': {
        if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');
        const raw = await callPanel('services');
        const list = Array.isArray((raw as any)?.data) ? (raw as any).data : raw;
        if (!Array.isArray(list)) return bad(res, 502, 'unexpected_upstream_payload');
        return res.json(list.map(mapService));
      }
      case 'order': {
        if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');
        const { service, link, quantity, runs, interval, comments } = req.body || {};
        if (!service || !link || !quantity) return bad(res, 400, 'missing_fields');
        const payload: any = { service, link, quantity };
        if (runs) payload.runs = runs;
        if (interval) payload.interval = interval;
        if (comments) payload.comments = comments;
        const out = await callPanel('add', payload);
        return res.json(out);
      }
      case 'status': {
        if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');
        const id = req.query.id as string;
        if (!id) return bad(res, 400, 'missing_id');
        const out = await callPanel('status', { order: id });
        return res.json(out);
      }
      case 'balance': {
        if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');
        const out = await callPanel('balance');
        return res.json(out);
      }
      case 'refill': {
        if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');
        const { order } = req.body || {};
        if (!order) return bad(res, 400, 'missing_order');
        const out = await callPanel('refill', { order });
        return res.json(out);
      }
      case 'cancel': {
        if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');
        const { order } = req.body || {};
        if (!order) return bad(res, 400, 'missing_order');
        const out = await callPanel('cancel', { order });
        return res.json(out);
      }
      case 'ping': {
        if (req.method !== 'GET') return bad(res, 405, 'method_not_allowed');
        const out = await callPanel('ping');
        return res.json(out ?? { ok: true });
      }
      default:
        return bad(res, 400, 'unknown_action');
    }
  } catch (err: any) {
    console.error('smm router failed:', err?.message || err);
    return res.status(502).json({ error: 'upstream', message: err?.message || String(err) });
  }
}