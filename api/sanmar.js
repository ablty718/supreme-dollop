export async function fetchSanMarCatalog(search) {
  const endpoint = "https://api.sanmar.com/v1/products";
  const res = await fetch(`${endpoint}?search=${encodeURIComponent(search)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.SANMAR_USER}:${process.env.SANMAR_PASS}`
      ).toString("base64")}`,
      "X-Account": process.env.SANMAR_ACCOUNT,
    },
  });

  if (!res.ok) throw new Error("SanMar API request failed");
  const data = await res.json();
  return data.products || [];
}
