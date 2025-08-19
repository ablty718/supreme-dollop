// /api/sanmar.js — v2 (more tolerant)
// SOAP proxy for SanMar search -> JSON (optionally normalized)
// New in v2:
//  - Runtime overrides via query params: action, ns, actionPrefix, soapVer, kwtag, pageTag, pageSizeTag
//  - Optional listPath to explicitly point to array in the SOAP result (dot.notation)
//  - More aggressive product detection and better debug payloads
//
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

    const url = new URL(req.url, 'http://localhost');
    const query = await readQuery(req, url);

    const action = (query.action || 'SearchProducts').trim();
    const q = (query.q || query.search || '').toString();
    const page = num(query.page, 1);
    const pageSize = num(query.pageSize || query.limit, 50);
    const normalize = isTrue(query.normalize);
    const debug = isTrue(query.debug);

    // Runtime overrides or env defaults
    const NS = (query.ns || process.env.SANMAR_SOAP_NS || 'http://api.sanmar.com/').trim();
    const ACTION_PREFIX = (query.actionPrefix || process.env.SANMAR_SOAP_ACTION_PREFIX || '').trim();
    const SOAP_VER = (query.soapVer || process.env.SANMAR_SOAP_VERSION || '1.1').trim(); // '1.1' or '1.2'
    const kwtag = (query.kwtag || 'Keywords').trim();
    const pageTag = (query.pageTag || 'PageNumber').trim();
    const pageSizeTag = (query.pageSizeTag || 'PageSize').trim();
    const listPath = (query.listPath || '').trim(); // e.g. "SearchProductsResponse.SearchProductsResult.Products.Product"

    const auth = {
      user: process.env.SANMAR_USER || '',
      pass: process.env.SANMAR_PASS || '',
      customer: process.env.SANMAR_CUSTOMER_NUMBER || '',
    };

    const bodyXml = buildActionXML({ ns: NS, action, q, page, pageSize, kwtag, pageTag, pageSizeTag });
    const envelope = buildEnvelope({ ns: NS, action, auth, payload: bodyXml });

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
        bodySnippet: rawText.slice(0, 1400),
      });
    }

    // Parse XML
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true });
    const xml = parser.parse(rawText);

    // Unwrap body + detect Fault
    const env = xml?.Envelope || xml?.['soap:Envelope'] || xml;
    const body = env?.Body || env?.['soap:Body'] || xml;
    const fault = body?.Fault || body?.['soap:Fault'];
    if (fault) return res.status(502).json({ ok: false, fault, message: fault?.faultstring || 'SOAP Fault' });

    // Pick response/result nodes
    const responseNode = pickResponseNode(body);
    const resultNode = pickResultNode(responseNode);

    // Optional direct listPath (dot-notation)
    let productRoot = resultNode;
    if (listPath) productRoot = getByPath(resultNode, listPath);

    let data = { ok: true, action, source: 'sanmar' };
    if (normalize) {
      const items = normalizeProducts(productRoot || body);
      data = { ...data, items, count: items.length };
    } else {
      data = { ...data, raw: productRoot || resultNode || body };
    }

    if (debug) {
      data.debug = {
        sentHeaders: redactHeaders(headers),
        envelopeSnippet: envelope.slice(0, 1400),
        responseSnippet: rawText.slice(0, 1400),
        ns: NS,
        soapVer: SOAP_VER,
        action,
        kwtag,
        pageTag,
        pageSizeTag,
        listPath: listPath || null,
        topKeys: Object.keys(resultNode || body || {}).slice(0, 50),
      };
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    return res.status(200).json(data);
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    return res.status(isAbort ? 504 : 500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ---------------- helpers ---------------- */
async function readQuery(req, url) {
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) return req.body || {};
  return Object.fromEntries(url.searchParams.entries());
}
const isTrue = (v) => ['1', 'true', 'yes', true].includes(String(v).toLowerCase());
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

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

function buildActionXML({ ns, action, q, page, pageSize, kwtag, pageTag, pageSizeTag }) {
  const Tag = `san:${escapeXml(action)}`;
  const kw = q ? `<san:${escapeXml(kwtag)}>${escapeXml(q)}</san:${escapeXml(kwtag)}>` : '';
  const pg = page ? `<san:${escapeXml(pageTag)}>${page}</san:${escapeXml(pageTag)}>` : '';
  const ps = pageSize ? `<san:${escapeXml(pageSizeTag)}>${pageSize}</san:${escapeXml(pageSizeTag)}>` : '';
  return `<${Tag}>${kw}${pg}${ps}</${Tag}>`;
}

function escapeXml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

function getByPath(obj, path) {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return cur;
    cur = cur[p];
  }
  return cur;
}

function normalizeProducts(body) {
  const buckets = [];

  // If caller supplied an exact listPath that ends at an array
  if (Array.isArray(body)) return body.map(mapProduct);

  // Typical SOAP shapes
  let directProducts = null;
  walk(body, (node, key) => {
    if (!key) return;
    if (/products?$/i.test(String(key)) && node && typeof node === 'object') {
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

  // Broad fallback: collect arrays that look product-ish
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
function redactHeaders(h) { const c = { ...h }; if (c.Authorization) c.Authorization = c.Authorization.split(' ')[0] + ' ***'; return c; }
