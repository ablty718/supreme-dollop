export async function fetchSNSCatalog(search) {
  const API_URL = `https://api.ssactivewear.com/v2/products?search=${encodeURIComponent(search)}`;
  const headers = {
    Authorization: `Basic ${Buffer.from(process.env.SNS_API_KEY + ":").toString("base64")}`,
  };
  const res = await fetch(API_URL, { headers });
  if (!res.ok) throw new Error("S&S API request failed");
  return await res.json();
}
