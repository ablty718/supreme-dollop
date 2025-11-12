import { fetchSNSCatalog } from "./ssaw.js";
import { fetchSanMarCatalog } from "./sanmar.js";
import { normalizeProduct } from "./normalize.js";

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const supplier = url.searchParams.get("supplier") || "sns";
  const query = url.searchParams.get("query") || "";

  try {
    let rawData = [];
    let source = supplier;

    if (supplier === "sns") {
      rawData = await fetchSNSCatalog(query);

      if (!rawData || rawData.length === 0) {
        console.log("No results from S&S — falling back to SanMar");
        rawData = await fetchSanMarCatalog(query);
        source = "sanmar";
      }

    } else if (supplier === "sanmar") {
      rawData = await fetchSanMarCatalog(query);

      if (!rawData || rawData.length === 0) {
        console.log("No results from SanMar — falling back to S&S");
        rawData = await fetchSNSCatalog(query);
        source = "sns";
      }

    } else {
      return res.status(400).json({ error: "Invalid supplier" });
    }

    const products = rawData.map((p) =>
      normalizeProduct({ ...p, provider: source })
    );

    res.status(200).json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Catalog fetch failed" });
  }
}
