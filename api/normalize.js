export function normalizeProduct(p) {
  return {
    brand: p.brand || p.brandName || "",
    style: p.style || p.styleName || "",
    color: p.color || p.colorName || "",
    size: p.size || p.sizeName || "",
    price: p.price || p.customerPrice || p.retailPrice || 0,
    imageFront: p.imageFront || p.colorFrontImage || "",
    imageBack: p.imageBack || p.colorBackImage || "",
    sku: p.sku || p.productId || "",
    provider: p.provider || (p.customerPrice ? "sns" : "sanmar"),
  };
}
