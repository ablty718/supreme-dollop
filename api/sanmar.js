// /api/sanmar.js
// SanMar SOAP proxy — correct param mapping + better endpoint handling
// ---------------------------------------------------------------
// ✅ What this endpoint accepts (query or JSON body):
//   q                 → free-text keywords
//   styleNumber | style | styleid
//   partNumber  | partnumber
//   brand       | brandName
//   color       | colorName
//   page, pageSize (defaults: 1, 50)
//   normalize   → '1' | 'true' to return unified product rows
//   debug       → '1' | 'true' to include troubleshooting payload
//   endpoint    → (optional) override SANMAR_SOAP_ENDPOINT for testing
//   action      → optional SOAP method (default: SearchProducts)
//
// 🚀 Notes
// - We map legacy RESTish params like ?path=products&styleid=... into proper SOAP fields.
// - If SANMAR_SOAP_ENDPOINT is empty, we return a helpful error (and show how to set it).
// - Requires: npm i fast-xml-parser
// - Optional env:
//     SANMAR_SOAP_ENDPOINT (required in prod)
//     SANMAR_SOAP_NS                default 'http://api.sanmar.com/'
//     SANMAR_SOAP_ACTION_PREFIX     e.g. 'http://api.sanmar.com/'
//     SANMAR_SOAP_VERSION           '1.1' (default) or '1.2'
//     SANMAR_USER, SANMAR_PASS, SANMAR_CUSTOMER_NUMBER (if your WSDL needs auth)

import { XMLParser } from 'fast-xml-parser';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // ---- Read query/body & normalize keys
    const inData = await readInput(req);
    const params = normalizeIncoming(inData);

    // ---- Resolve endpoint & SOAP config
    const endpoint = (params.endpoint || process.env.SANMAR_SOAP_ENDPOINT || '').trim();
    if (!endpoint) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SANMAR_SOAP_ENDPOINT',
        hint: 'Set an environment variable SANMAR_SOAP_ENDPOINT to your SanMar SOAP service URL or pass ?endpoint=... for testing.',
        example: {
          vercel: 'vercel env add SANMAR_SOAP_ENDPOINT',
          local: 'SANMAR_SOAP_ENDPOINT=https://your.sanmar/ws/SanMarService.svc'
        }
      });
    }

    const NS = (process.env.SANMAR_SOAP_NS || 'http://api.sanmar.com/').trim();
    const ACTION_PREFIX = (process.env.SANMAR_SOAP_ACTION_PREFIX || '').trim();
    const SOAP_VER = (process.env.SANMAR_SOAP_VERSION || '1.1').trim(); // '1.1' or '1.2'
    const USER = process.env.SANMAR_USER || '';
    const PASS = process.env.SANMAR_PASS || '';
    const CUST = process.env.SANMAR_CUSTOMER_NUMBER || '';

    // ---- Choose action (default SearchProducts)
    const action = String(inData.action || 'SearchProducts');

    // ---- Build SOAP body
    const payload = buildActionXML({ action, ns: NS, params });

    // ---- Envelope & headers
    const envelope = buildEnvelope({ ns: NS, action, auth: { user: USER, pass: PASS, customer: CUST }, payload });
    const headers = SOAP_VER === '1.2'
      ? { 'Content-Type': 'application/soap+xml; charset=utf-8' }
      : { 'Content-Type': 'text/xml; charset=utf-8', ...(ACTION_PREFIX || action ? { SOAPAction: ACTION_PREFIX ? `${ACTION_PREFIX}${action}` : action } : {}) };

    // ---- Call SOAP
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const resp = await fetch(endpoint, { method: 'POST', headers, body: envelope, signal: ac.signal });
    clearTimeout(timer);

    const rawText = await resp.text();
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, status: resp.status, statusText: resp.statusText, bodySnippet: rawText.slice(0, 2000) });
    }

    // ---- Parse XML
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true });
    const xml = parser.parse(rawText);
    const env = xml?.Envelope || xml?.['soap:Envelope'] || xml;
    const body = env?.Body || env?.['soap:Body'] || xml;
    const fault = body?.Fault || body?.['soap:Fault'];
    if (fault) return res.status(502).json({ ok: false, fault, message: fault?.faultstring || 'SOAP Fault' });

    const responseNode = pickResponseNode(body);
    const resultNode = pickResultNode(responseNode);

    const normalize = params.normalize;
    let data = { ok: true, action };
    if (normalize) {
      const items = normalizeProducts(resultNode || body);
      data = { ...data, items, count: items.length, source: 'sanmar' };
    } else {
      data = { ...data, raw: resultNode || body };
    }

    if (params.debug) {
      data.debug = {
        endpointUsed: endpoint,
        action,
        sentHeaders: headers,
        resolvedParams: { ...params, endpoint: undefined },
        envelopeSnippet: redactSecrets(envelope).slice(0, 1600),
        responseSnippet: rawText.slice(0, 1600),
      };
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    return res.status(isAbort ? 504 : 500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------------- Input helpers ---------------- */
async function readInput(req) {
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    return req.body || {};
  }
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function normalizeIncoming(q) {
  const page = num(q.page) || 1;
  const pageSize = num(q.pageSize || q.limit) || 50;

  // Accept many aliases; map legacy RESTish keys to SOAPish semantics
  const params = {
    keywords: firstVal(q.q, q.search, q.keywords, q.style, q.styleid, q.partnumber, q.partNumber),
    styleNumber: firstVal(q.styleNumber, q.style, q.styleid),
    partNumber: firstVal(q.partNumber, q.partnumber),
    brand: firstVal(q.brand, q.brandName),
    color: firstVal(q.color, q.colorName),
    page,
    pageSize,
    normalize: yes(q.normalize),
    debug: yes(q.debug),
    endpoint: q.endpoint,
  };

  // If style/part provided but no keywords, don't force keywords
  if (!params.keywords && (params.styleNumber || params.partNumber)) {
    // leave keywords empty
  }
  return params;
}

function firstVal(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  return '';
}
function yes(v) { return v === '1' || v === 'true' || v === true; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/* ---------------- SOAP builders ---------------- */
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

function buildActionXML({ action, ns, params }) {
  const A = `san:${escapeXml(action)}`;

  // Default → SearchProducts with a flexible set of filters
  if (!action || /searchproducts/i.test(action)) {
    const nodes = [
      node('Keywords', params.keywords),
      node('StyleNumber', params.styleNumber),
      node('PartNumber', params.partNumber),
      node('BrandName', params.brand),
      node('ColorName', params.color),
      node('PageNumber', params.page),
      node('PageSize', params.pageSize),
    ].filter(Boolean).join('\n');
    return `<${A}>\n${nodes}\n</${A}>`;
  }

  // If someone explicitly calls other actions, pass through a minimal shape
  // (adjust element names to match your WSDL if needed)
  const nodes = [
    node('Keywords', params.keywords),
    node('StyleNumber', params.styleNumber),
    node('PartNumber', params.partNumber),
    node('PageNumber', params.page),
    node('PageSize', params.pageSize),
  ].filter(Boolean).join('\n');
  return `<${A}>\n${nodes}\n</${A}>`;
}

function node(tag, val) {
  if (val === undefined || val === null || String(val) === '') return '';
  return `  <san:${tag}>${escapeXml(String(val))}</san:${tag}>`;
}

function escapeXml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- XML pickers & walkers ---------------- */
function pickResponseNode(body) {
  if (!body || typeof body !== 'object') return body;
  for (const k of Object.keys(body)) if (/response$/i.test(k)) return body[k];
  return body;
}
function pickResultNode(node) {
  if (!node || typeof node !== 'object') return node;
  for (const k of Object.keys(node)) if (/result$/i.test(k)) return node[k];
  return node;
}
function walk(node, fn, key = '') {
  fn(node, key);
  if (Array.isArray(node)) for (const item of node) walk(item, fn, key);
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], fn, k);
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

  // Fallback buckets
  walk(body, (node, key) => {
    if (Array.isArray(node) && /product|item/i.test(String(key || ''))) buckets.push(...node);
    if (node && typeof node === 'object' && !Array.isArray(node) && /product|item/i.test(String(key || ''))) buckets.push(node);
  });

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
    return arr.findIndex(y => `${y.sku}|${y.sizeName}` === key) === i;
  });
}

function mapProduct(p) {
  const sku = p.SKU || p.Sku || p.PartNumber || p.PartNo || p.StyleNumber || p.StyleNo || p.ItemNumber || p.ItemNo || p.Id || p.ID;
  const brand = p.Brand || p.BrandName || p.Mill || p.MillName;
  const style = p.Style || p.StyleName || p.ProductName || p.Name || p.DescriptionShort || p.Description;
  const color = p.Color || p.ColorName || p.ColorDesc;
  const size = p.Size || p.SizeName;
  const title = p.Description || p.ProductTitle || p.ProductName || p.DescriptionLong || style;
  const price = nnum(p.Price) ?? nnum(p.CustomerPrice) ?? nnum(p.SalePrice) ?? nnum(p.Cost) ?? 0;
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

function nnum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pickImage(p) { for (const k of Object.keys(p || {})) if (/image/i.test(k) && typeof p[k] === 'string' && /^https?:/i.test(p[k])) return p[k]; return null; }

/* ---------------- Utilities ---------------- */
function redactSecrets(s) {
  return s
    .replace(/<san:Password>[^<]*<\/san:Password>/gi, '<san:Password>••••••</san:Password>')
    .replace(/<san:Username>[^<]*<\/san:Username>/gi, '<san:Username>••••••</san:Username>')
    .replace(/<san:CustomerNumber>[^<]*<\/san:CustomerNumber>/gi, '<san:CustomerNumber>••••••</san:CustomerNumber>');
}
