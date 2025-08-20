// /api/sanmar.js
// SOAP proxy for SanMar search -> JSON (optionally normalized)
// Deps:  npm i fast-xml-parser
// Env:
//   SANMAR_SOAP_ENDPOINT (required) e.g. https://.../SanMarService.svc
//   SANMAR_SOAP_NS                   default 'http://api.sanmar.com/'
//   SANMAR_SOAP_ACTION_PREFIX        e.g. 'http://api.sanmar.com/'
//   SANMAR_SOAP_VERSION              '1.1' (default) or '1.2'
//   SANMAR_USER, SANMAR_PASS, SANMAR_CUSTOMER_NUMBER (optional if required by WSDL)

import { XMLParser } from 'fast-xml-parser';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const endpoint = (process.env.SANMAR_SOAP_ENDPOINT || '').trim();
    if (!endpoint) return res.status(500).json({ ok: false, error: 'Missing SANMAR_SOAP_ENDPOINT' });

    const NS = (process.env.SANMAR_SOAP_NS || 'http://api.sanmar.com/').trim();
    const ACTION_PREFIX = (process.env.SANMAR_SOAP_ACTION_PREFIX || '').trim();
    const SOAP_VER = (process.env.SANMAR_SOAP_VERSION || '1.1').trim(); // '1.1' or '1.2'
    const USER = process.env.SANMAR_USER || '';
    const PASS = process.env.SANMAR_PASS || '';
    const CUST = process.env.SANMAR_CUSTOMER_NUMBER || '';

    // Read params
    let query;
    if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
      query = req.body || {};
    } else {
      const url = new URL(req.url, 'http://localhost');
      query = Object.fromEntries(url.searchParams.entries());
    }
    const action = (query.action || 'SearchProducts').trim();
    const q = (query.q || query.search || '').toString();
    const page = Number(query.page || 1);
    const pageSize = Number(query.pageSize || query.limit || 50);
    const normalize = query.normalize === '1' || query.normalize === 'true';
    const debug = query.debug === '1' || query.debug === 'true';

    // Build SOAP envelope
    const bodyXml = buildActionXML({ ns: NS, action, q, page, pageSize });
    const envelope = buildEnvelope({
      ns: NS,
      action,
      auth: { user: USER, pass: PASS, customer: CUST },
      payload: bodyXml,
    });

    // Headers for SOAP 1.1 vs 1.2
    const headers = SOAP_VER === '1.2'
      ? { 'Content-Type': 'application/soap+xml; charset=utf-8' }
      : { 'Content-Type': 'text/xml; charset=utf-8', ...(ACTION_PREFIX || action ? { SOAPAction: ACTION_PREFIX ? `${ACTION_PREFIX}${action}` : action } : {}) };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);

    const resp = await fetch(endpoint, { method: 'POST', headers, body: envelope, signal: ac.signal });
    clearTimeout(timer);

    const rawText = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).json({
        ok: false,
        status: resp.status,
        statusText: resp.statusText,
        bodySnippet: rawText.slice(0, 1200),
      });
    }

    // Parse XML
    const parser = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true, // collapse ns:Tag -> Tag
      trimValues: true,
    });
    const xml = parser.parse(rawText);

    // Unwrap body + detect Fault
    const env = xml?.Envelope || xml?.['soap:Envelope'] || xml;
    const body = env?.Body || env?.['soap:Body'] || xml;
    const fault = body?.Fault || body?.['soap:Fault'];
    if (fault) {
      return res.status(502).json({ ok: false, fault, message: fault?.faultstring || 'SOAP Fault' });
    }

    // Try to pick a response node like <SearchProductsResponse><SearchProductsResult>...</...>
    const responseNode = pickResponseNode(body);
    const resultNode = pickResultNode(responseNode);

    let data = { ok: true, action };
    if (normalize) {
      const items = normalizeProducts(resultNode || body);
      data = { ...data, items, count: items.length, source: 'sanmar' };
    } else {
      data = { ...data, raw: resultNode || body };
    }

    if (debug) {
      data.debug = {
        sentHeaders: headers,
        envelopeSnippet: envelope.slice(0, 1200),
        responseSnippet: rawText.slice(0, 1200),
      };
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    return res.status(isAbort ? 504 : 500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------------- SOAP helpers ---------------- */

function buildEnvelope({ ns, action, auth, payload }) {
  const hasAuth = auth?.user || auth?.pass || auth?.customer;
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:san="${escapeXml(ns)}">
  <soapenv:Header>
    ${hasAuth ? `
    <san:AuthHeader>
      ${auth.user ? `<san:Username>${escapeXml(auth.user)}</san:Username>` : ''}
      ${auth.pass ? `<san:Password>${escapeXml(auth.pass)}</san:Password>` : ''}
      ${auth.customer ? `<san:CustomerNumber>${escapeXml(auth.customer)}</san:CustomerNumber>` : ''}
    </san:AuthHeader>` : ''}
  </soapenv:Header>
  <soapenv:Body>
    ${payload}
  </soapenv:Body>
</soapenv:Envelope>`;
}

// Adjust element names to match your WSDL if needed
function buildActionXML({ ns, action, q, page, pageSize }) {
  const Tag = `san:${escapeXml(action)}`;
  const kw = q ? `<san:Keywords>${escapeXml(q)}</san:Keywords>` : '';
  const pg = page ? `<san:PageNumber>${page}</san:PageNumber>` : '';
  const ps = pageSize ? `<san:PageSize>${pageSize}</san:PageSize>` : '';
  return `<${Tag}>
    ${kw}
    ${pg}
    ${ps}
  </${Tag}>`;
}

function escapeXml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- XML pickers & walkers ---------------- */

function pickResponseNode(body) {
  // Find the first *Response node
  if (!body || typeof body !== 'object') return body;
  for (const k of Object.keys(body)) {
    if (/response$/i.test(k)) return body[k];
  }
  return body;
}
function pickResultNode(node) {
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) {
    if (/result$/i.test(k)) return node[k];
  }
  return node;
}

function walk(node, fn, key = '') {
  fn(node, key);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, fn, key);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      walk(node[k], fn, k);
    }
  }
}

/* ---------------- Normalizer ---------------- */

function normalizeProducts(body) {
  const buckets = [];

  // Common SOAP shapes: ...Response -> ...Result -> Products -> Product[]
  let directProducts = null;
  walk(body, (node, key) => {
    if (key && /products$/i.test(String(key)) && node && typeof node === 'object') {
      const arr = Array.isArray(node.Product) ? node.Product : node.Product ? [node.Product] : null;
      if (arr && arr.length) directProducts = arr;
    }
  });
  if (directProducts) return directProducts.map(mapProduct);

  // Fallback: any arrays keyed like Product / Item
  walk(body, (node, key) => {
    if (Array.isArray(node) && /product|item/i.test(String(key || ''))) buckets.push(...node);
    if (node && typeof node === 'object' && !Array.isArray(node) && /product|item/i.test(String(key || ''))) buckets.push(node);
  });

  // If still empty, collect arrays that look product-ish
  if (!buckets.length) {
    walk(body, (node) => {
      if (Array.isArray(node)) {
        const pick = node.filter(isProductish);
        if (pick.length) buckets.push(...pick);
      }
    });
  }

  return buckets.map(mapProduct).filter((x, i, arr) => {
    const key = `${x.sku}|${x.sizeName}`;
    const seenBefore = arr.findIndex(y => `${y.sku}|${y.sizeName}` === key);
    return seenBefore === i;
  });
}

function mapProduct(p) {
  const sku = p.SKU || p.Sku || p.PartNumber || p.PartNo || p.StyleNumber || p.StyleNo || p.ItemNumber || p.ItemNo || p.Id || p.ID;
  const brand = p.Brand || p.BrandName || p.Mill || p.MillName;
  const style = p.Style || p.StyleName || p.ProductName || p.Name || p.DescriptionShort || p.Description;
  const color = p.Color || p.ColorName || p.ColorDesc;
  const size = p.Size || p.SizeName;
  const title = p.Description || p.ProductTitle || p.ProductName || p.DescriptionLong || style;
  const price = num(p.Price) ?? num(p.CustomerPrice) ?? num(p.SalePrice) ?? num(p.Cost) ?? 0;
  const imgFront = p.ImageFrontURL || p.ImageURL || p.Image || pickImage(p);
  const imgBack = p.ImageBackURL || p.BackImageURL || null;

  return {
    sku: String(sku ?? ''),
    brandName: brand ? String(brand) : '',
    styleName: style ? String(style) : '',
    colorName: color ? String(color) : '',
    sizeName: size ? String(size) : '',
    title: title ? String(title) : '',
    customerPrice: price,
    colorFrontImage: imgFront || '',
    colorBackImage: imgBack || '',
    source: 'sanmar',
  };
}

function isProductish(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  return (
    keys.includes('sku') ||
    keys.includes('partnumber') ||
    keys.includes('stylenumber') ||
    keys.includes('productname') ||
    keys.includes('brand') ||
    keys.includes('brandname')
  );
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickImage(p) {
  for (const k of Object.keys(p || {})) {
    if (/image/i.test(k) && typeof p[k] === 'string' && /^https?:/i.test(p[k])) return p[k];
  }
  return null;
}
