// /api/ssaw.js — Node serverless function for Vercel
export default async function handler(req, res) {
  // CORS (optional: restrict origin to your domain)
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const BASE = 'https://api.ssactivewear.com/v2';
  const {
    path = 'products',     // products | inventory | styles | categories | specs | brands
    products,              // e.g. "B00760004" or comma list
    style, styleid, partnumber, // pass through S&S filters
    warehouses,            // e.g. "IL,KS"
    fields,                // comma list of fields (use to limit payload)
    mediatype = 'json'     // S&S default is json
  } = req.query;

  const qs = new URLSearchParams();
  if (style) qs.set('style', String(style));
  if (styleid) qs.set('styleid', String(styleid));
  if (partnumber) qs.set('partnumber', String(partnumber));
  if (warehouses) qs.set('Warehouses', String(warehouses));
  if (fields) qs.set('fields', String(fields));
  if (mediatype) qs.set('mediatype', String(mediatype));

  let url = `${BASE}/${encodeURIComponent(path)}/`;
  if (products) url = `${BASE}/${encodeURIComponent(path)}/${encodeURIComponent(products)}`;
  url += qs.toString() ? `?${qs}` : '';

  // HTTP Basic auth (acct#:apiKey)
  const acct = process.env.SSAW_ACCOUNT;
  const key = process.env.SSAW_API_KEY;
  if (!acct || !key) return res.status(500).json({ error: 'Missing SSAW credentials' });
  const auth = Buffer.from(`${acct}:${key}`).toString('base64');

  const upstream = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });

  const status = upstream.status;
  const data = await upstream.json().catch(() => ({ error: 'Upstream parse error' }));

  // Expand image paths like "Images/Color/..." to full URLs
  const prefix = 'https://www.ssactivewear.com/';
  const expand = (row) => {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        const v = row[k];
        if (typeof v === 'string' && v.startsWith('Images/')) row[k] = prefix + v;
      }
    }
    return row;
  };
  const out = Array.isArray(data) ? data.map(expand) : expand(data);

  // Helpful cache (60/min limit) — cache at the edge for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(out);
}
