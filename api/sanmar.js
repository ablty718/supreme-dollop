// api/sanmar.js
import { XMLParser } from 'fast-xml-parser';

export const config = { runtime: 'edge' }; // or remove if using node runtime

const WSDL_BASE = (process.env.SANMAR_WSDL_BASE || 'https://ws.sanmar.com:8080').replace(/\/+$/, '');
const PRODUCT_INFO_ENDPOINT = `${WSDL_BASE}/SanMarWebService/SanMarProductInfoServicePort`;

const CUST = process.env.SANMAR_CUSTOMER_NUMBER;
const USER = process.env.SANMAR_USERNAME;
const PASS = process.env.SANMAR_PASSWORD;

function buildSoapBody({ style, partnumber, styleid }) {
  // SanMar “getProducts” supports filter arrays; we’ll pass whatever the client provided.
  // You can expand with FilterBrandArray etc. later.
  const filters = [];
  if (style)       filters.push(`<filterStyle>${escapeXml(style)}</filterStyle>`);
  if (partnumber)  filters.push(`<filterPartNumber>${escapeXml(partnumber)}</filterPartNumber>`);
  if (styleid)     filters.push(`<filterStyleID>${escapeXml(styleid)}</filterStyleID>`);

  const filterBlock = filters.length
    ? `<FilterStyleArray>${filters.join('')}</FilterStyleArray>`
    : '';

  return `
  <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="http://webservices.sanmar.com/">
    <soapenv:Header/>
    <soapenv:Body>
      <ws:getProducts>
        <ws:requestBean>
          <ws:sanMarCustomerNumber>${escapeXml(CUST || '')}</ws:sanMarCustomerNumber>
          <ws:sanMarUserName>${escapeXml(USER || '')}</ws:sanMarUserName>
          <ws:sanMarUserPassword>${escapeXml(PASS || '')}</ws:sanMarUserPassword>
          ${filterBlock}
          <!-- add FilterColorArray/FilterSizeArray/etc as needed per docs -->
        </ws:requestBean>
      </ws:getProducts>
    </soapenv:Body>
  </soapenv:Envelope>
  `.trim();
}

function escapeXml(s){ return String(s).replace(/[<>&'"]/g, c=>({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c])); }

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  try {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const style      = searchParams.get('style') || '';
    const partnumber = searchParams.get('partnumber') || '';
    const styleid    = searchParams.get('styleid') || '';

    if (!CUST || !USER || !PASS) {
      return res.status(500).json({ error: 'Missing SanMar credentials env vars.' });
    }

    const soapBody = buildSoapBody({ style, partnumber, styleid });

    const r = await fetch(PRODUCT_INFO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'getProducts', // SOAP 1.1 action
      },
      body: soapBody,
    });

    const xml = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ error: 'SanMar fetch failed', status: r.status, body: xml?.slice(0, 2000) });
    }

    // Parse XML -> JSON
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);

    // Navigate to the payload; paths can vary—handle both common shapes
    const body =
      parsed?.['S:Envelope']?.['S:Body'] ||
      parsed?.['soapenv:Envelope']?.['soapenv:Body'] ||
      parsed?.Envelope?.Body ||
      parsed;

    const items =
      body?.['ns2:getProductsResponse']?.return?.items ||
      body?.getProductsResponse?.return?.items ||
      body?.['getProductsResponse']?.return?.items ||
      [];

    // Normalize to an array
    const list = Array.isArray(items) ? items : (items ? [items] : []);

    // Send raw-ish items; your client already normalizes with normalizeSanMar()
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ items: list });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
