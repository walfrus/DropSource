const PANEL_API_URL = process.env.PANEL_API_URL!;
const PANEL_API_KEY = process.env.PANEL_API_KEY!;

export default async function handler(req: any, res: any) {
  try {
    if (!PANEL_API_URL || !PANEL_API_KEY) {
      return res.status(500).json({ error: 'Missing PANEL_API_URL or PANEL_API_KEY' });
    }

    if (req.method === 'GET') {
      const action = req.query.action as string;

      if (action === 'services') {
        const r = await fetch(PANEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key: PANEL_API_KEY, action: 'services' }),
        });
        const data = await r.json();

        const q = (req.query.q as string)?.toLowerCase() || '';
        const cat = (req.query.category as string)?.toLowerCase() || '';

        const services = Object.values<any>(data).map((s: any) => ({
          id: s.service,
          name: s.name,
          category: s.category,
          price_per_1k: Number(s.rate),
          min: Number(s.min),
          max: Number(s.max),
          dripfeed: Boolean(s.dripfeed),
          refill: Boolean(s.refill),
          description: s.desc || '',
        }))
        .filter(s => (!q || s.name.toLowerCase().includes(q)) && (!cat || s.category.toLowerCase().includes(cat)));

        return res.json(services);
      }

      if (action === 'balance') {
        const r = await fetch(PANEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key: PANEL_API_KEY, action: 'balance' }),
        });
        const data = await r.json();
        return res.json(data);
      }

      if (action === 'status') {
        const orderId = req.query.order as string;
        if (!orderId) return res.status(400).json({ error: 'Missing order id' });

        const r = await fetch(PANEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ key: PANEL_API_KEY, action: 'status', order: orderId }),
        });
        const data = await r.json();
        return res.json(data);
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      const { action, service, link, quantity, runs, interval } = req.body;

      if (action === 'add') {
        if (!service || !link || !quantity) {
          return res.status(400).json({ error: 'Missing required params' });
        }

        const params: any = {
          key: PANEL_API_KEY,
          action: 'add',
          service,
          link,
          quantity,
        };
        if (runs) params.runs = runs;
        if (interval) params.interval = interval;

        const r = await fetch(PANEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params),
        });
        const data = await r.json();
        return res.json(data);
      }

      return res.status(400).json({ error: 'Unknown or missing action in POST' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err: any) {
    console.error('Error in smm handler:', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
}