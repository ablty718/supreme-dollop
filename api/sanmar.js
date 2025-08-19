// /api/sanmar.js — Vercel/Next.js API route for SanMar SOAP
// Guards missing dependencies so the function doesn't hard-crash
import { XMLParser, XMLBuilder, XMLValidator } from "fast-xml-parser";

export default async function handler(req, res) {
  // CORS (optional)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const debug = 'debug' in req.query || req.query?.debug === '1';

  // --- Dynamic import so we can return a clear JSON error if it's missing ---
  let XMLParser;
  try {
    ({ XMLParser } = await import('fast-xml-parser'));
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error:
        "Missing dependency: fast-xml-parser. Add it to 'dependencies' (not devDependencies) and redeploy.",
      hint: {
        npm: 'npm i fast-xml-parser',
        yarn: 'yarn add fast-xml-parser',
        pnpm: 'pnpm add fast-xml-parser',
      },
    });
  }

  const endpoint = (process.env.SANMAR_SOAP_ENDPOINT || '').trim();
  const soapAction = (process.env.SANMAR_SOAP_ACTION || '').trim(); // e.g., "SearchProducts" (use the exact action from SanMar docs)

  if (!endpoint || !soapAction) {
    return res.status(500).json({
      ok: false,
      error: 'SANMAR_SOAP_ENDPOINT or SANMAR_SOAP_ACTION env var is missing',
    });
  }

  // Inputs
  const q = (req.query?.q || '').toString().trim();
  const page = parseInt((req.query?.page || '1').toString(), 10) || 1;
  const pageSize = Math.min(100, Math.max(1, parseInt((req.query?.pageSize || '50').toString(), 10) || 50));

  // --- Build SOAP envelope (replace namespace/op names to match SanMar WSDL) ---
  const envelope = buildEnvelope({ q, page, pageSize, action: soapAction });

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapAction,
      },
      body: envelope,
    });

    const xml = await upstream.text();
    const status = upstream.status;

    // Parse XML → JSON
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    let parsed;
    try {
      parsed = parser.parse(xml);
    } catch (e) {
      return res.status(502).json({ ok: false, status, error: 'Failed to parse SOAP XML', xmlSnippet: xml.slice(0, 400) });
    }

    // Extract items from parsed SOAP body — update the path per SanMar's schema
    const { items, notes } = normalizeItemsFromSoap(parsed);

    const payload = {
      ok: status >= 200 && status < 300,
      items,
      ...(debug
        ? {
            stats: {
              ok: status >= 200 && status < 300,
              status,
              count: items.length,
              url: endpoint,
              error: status >= 400 ? getSoapFault(parsed) || `HTTP ${status}` : undefined,
            },
            debug: { notes, soapAction, page, pageSize },
          }
        : {}),
    };

    // If upstream failed, propagate with helpful context
    if (!payload.ok) {
      return res.status(502).json(payload);
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// --- Helpers ---
function escapeXml(s = '') {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildEnvelope({ q, page, pageSize, action }) {
  // TODO: Replace namespace + operation names with SanMar's WSDL details.
  // The below is a *template* to get the plumbing working.
  const ns = 'http://tempuri.org/';
  const op = action; // assume soapAction equals the op/operation name
  return `<?xml version="1.0" encoding="utf-8"?>
  <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
      <${op} xmlns="${ns}">
        <query>${escapeXml(q)}</query>
        <page>${page}</page>
        <pageSize>${pageSize}</pageSize>
      </${op}>
    </soap:Body>
  </soap:Envelope>`;
}

function getSoapFault(parsed) {
  try {
    const fault =
      parsed?.Envelope?.Body?.Fault ||
      parsed?.['soap:Envelope']?.['soap:Body']?.['soap:Fault'] ||
      parsed?.['S:Envelope']?.['S:Body']?.['S:Fault'];
    if (!fault) return undefined;
    return [fault?.faultcode, fault?.faultstring].filter(Boolean).join(': ');
  } catch (_) {
    return undefined;
  }
}

function normalizeItemsFromSoap(parsed) {
  // TODO: Walk the parsed object and map product rows to your CatalogRow shape.
  // Returning empty array by default so UI doesn't crash while you wire this up.
  // Add notes to help you find the right path quickly in debug mode.
  const notes = Object.keys(parsed || {});
  return { items: [], notes };
}
