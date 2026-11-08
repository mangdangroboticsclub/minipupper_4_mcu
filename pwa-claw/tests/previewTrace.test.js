import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PREVIEW_SKU,
  fetchPreviewManifest,
  resolvePreviewSku,
} from "../src/lib/previewTrace.js";

test("preview SKU defaults to Mini Pupper 4 without overriding valid manifests", () => {
  assert.equal(DEFAULT_PREVIEW_SKU, "sku_1");
  for (const missing of [undefined, null, "", "sku_3", "Mini Pupper 4"]) {
    assert.equal(resolvePreviewSku(missing), "sku_1");
  }
  assert.equal(resolvePreviewSku("sku_1"), "sku_1");
  assert.equal(resolvePreviewSku("sku_2"), "sku_2");
});

test("manifest loading normalizes only missing or unsupported SKUs", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [input, expected] of [[undefined, "sku_1"], ["sku_3", "sku_1"], ["sku_2", "sku_2"]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ preview_format: 2, sku: input }));
      const manifest = await fetchPreviewManifest("t", "1.0.0", { base: "http://preview.invalid" });
      assert.equal(manifest.sku, expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
