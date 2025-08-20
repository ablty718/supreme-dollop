// api/sanmar.js  (Node runtime)
const { XMLParser } = require('fast-xml-parser');

const WSDL_BASE = (process.env.SANMAR_WSDL_BASE || 'https://ws.sanmar.com:8080').replace(/\/+$/, '');
const PRODUCT_INFO_ENDPOINT = `${WSDL_BASE}/SanMarWebService/SanMarProductInfoServicePort`;

const CUST = process.env.SANMAR_CUSTOMER_NUMBER;
const USER = process.env.SANMAR_USERNAME;
const PASS = process.env.SANMAR_PASSWORD;

function escapeXml(s) { return String(s).replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c])); }

function buildSoapBody({ style, partnumber, styleid }) {
  const filters = [];
  if (style)       filters.push(`<filterStyle>${escapeXml(style)}</filterStyle>`);
  if (partnumber)  filters.push(`<filterPartNumber>${escapeXml(partnumber)}</filterPartNumber>`);
  if (styleid)     filters.push(`<filterStyleID>${escapeXml(styleid)}</filterStyleID>`);
  const filterBlock = filters.length ? `<FilterStyleArray>${filters.join('')}</FilterStyleArray>` : '';

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
        </ws:requestBean>
      </ws:getProducts>
    </soapenv:Body>
  </soapenv:Envelope>`.trim();
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const style      = url.searchParams.get('style') || '';
    const partnumber = url.searchParams.get('partnumber') || '';
    const styleid    = url.searchParams.get('styleid') || '';

    if (!CUST || !USER || !PASS) {
      return res.status(500).json({ error: 'Missing SanMar credentials env vars.' });
    }

    const soapBody = buildSoapBody({ style, partnumber, styleid });

    const r = await fetch(PRODUCT_INFO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'getProducts',
      },
      body: soapBody,
    });

    const xml = await r.text();

    if (!r.ok) {
      // Keep some of the body to help debug
      return res.status(r.status).json({ error: 'SanMar fetch failed', status: r.status, body: xml.slice(0, 2000) });
    }

    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);

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

    const list = Array.isArray(items) ? items : (items ? [items] : []);

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ items: list });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
};
