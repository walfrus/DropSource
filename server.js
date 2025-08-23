import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

const API_URL = process.env.PANEL_API_URL || 'https://smmgoal.com/api/v2';
const KEY = process.env.PANEL_API_KEY;
const MULT = Number(process.env.PRICE_MULTIPLIER || 1.25);
const FLAT = Number(process.env.PRICE_FLAT_FEE || 0);

// helper: call panel
async function panel(action, params = {}) {
  const body = new URLSearchParams({ key: KEY, action, ...params });
  const { data } = await axios.post(API_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return data;
}

// cache services for 2 min so we don’t slam the panel
let cache = { services: null, ts: 0 };
const TTL = 120 * 1000;

// map raw services -> public services with your pricing
function toPublicService(s) {
  // panel typically returns: { service, name, rate, min, max, category, dripfeed, refill, cancel, type, ... }
  const baseRatePer1k = Number(s.rate || s['rate(1k)'] || s.price || 0); // try common keys
  const yourRatePer1k = +(baseRatePer1k * MULT + FLAT * 1000).toFixed(2);

  return {
    id: s.service ?? s.id,
    name: s.name ?? s.title ?? 'Service',
    category: s.category ?? s['service_category'] ?? 'General',
    min: Number(s.min || 0),
    max: Number(s.max || 0),
    dripfeed: Boolean(s.dripfeed) || s['dripfeed'] === 'true',
    refill: Boolean(s.refill) || s['refill'] === 'true',
    cancel: Boolean(s.cancel) || s['cancel'] === 'true',
    // show both rates for transparency in your admin if you want
    panel_rate_per_1k: baseRatePer1k,
    price_per_1k: yourRatePer1k,
    // optional descriptions the panel may provide:
    details: s.description || s.note || ''
  };
}

// GET services (public)
app.get('/api/services', async (req, res) => {
  try {
    const now = Date.now();
    if (!cache.services || now - cache.ts > TTL) {
      const data = await panel('services');
      const arr = Array.isArray(data) ? data : data.services || [];
      cache.services = arr.map(toPublicService);
      cache.ts = now;
    }
    // optional filtering by category or search
    const { q = '', category } = req.query;
    let out = cache.services;
    if (category) out = out.filter(s => (s.category || '').toLowerCase() === String(category).toLowerCase());
    if (q) {
      const n = String(q).toLowerCase();
      out = out.filter(s => (s.name + ' ' + s.category).toLowerCase().includes(n));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_fetch_services', detail: e?.message });
  }
});

// POST order
app.post('/api/order', async (req, res) => {
  try {
    const { service, link, quantity, runs, interval } = req.body || {};
    if (!service || !link || !quantity) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const payload = { service, link, quantity };
    if (runs) payload.runs = runs;
    if (interval) payload.interval = interval;

    const data = await panel('add', payload);
    // panel usually returns { order: 12345 } OR { error: "msg" }
    if (data.error) return res.status(400).json({ error: data.error });
    res.json({ order: data.order });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_create_order', detail: e?.message });
  }
});

// GET order status
app.get('/api/status/:orderId', async (req, res) => {
  try {
    const data = await panel('status', { order: req.params.orderId });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_status', detail: e?.message });
  }
});

// POST refill/cancel (bulk supported by comma-joined IDs)
app.post('/api/refill', async (req, res) => {
  try {
    const { order } = req.body || {};
    const data = await panel('refill', { order });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_refill', detail: e?.message });
  }
});

app.post('/api/cancel', async (req, res) => {
  try {
    const { orders } = req.body || {}; // up to 100 IDs comma-separated
    const data = await panel('cancel', { orders });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_cancel', detail: e?.message });
  }
});

// GET balance (for your dashboard)
app.get('/api/balance', async (_req, res) => {
  try {
    const data = await panel('balance');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'failed_to_get_balance', detail: e?.message });
  }
});

// serve static frontend (drop the index.html next to server.js)
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('reseller api listening on', PORT));