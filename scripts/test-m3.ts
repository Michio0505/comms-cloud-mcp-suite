/**
 * Smoke test for M3 get_product_details.
 *
 * Usage:
 *   npx tsx scripts/test-m3.ts <org-alias>:<product-id> [...]
 *
 * Example:
 *   npx tsx scripts/test-m3.ts \
 *     vlocity-cmt-org:01tak00000O7sMGAAZ \
 *     kyocera-comms:01td5000006Ny6cAAC
 */
import { SfClient } from "../src/sf-client.js";
import { GetProductDetailsTool } from "../src/tools/m3-get-product-details.js";

const pairs = process.argv.slice(2);
if (pairs.length === 0) {
  console.error(
    "Usage: tsx scripts/test-m3.ts <org-alias>:<product-id> [<org-alias>:<product-id> ...]"
  );
  process.exit(1);
}

const sfClient = new SfClient();
const tool = new GetProductDetailsTool({ sfClient });

for (const pair of pairs) {
  const idx = pair.indexOf(":");
  if (idx < 0) {
    console.error(`Skipping malformed argument '${pair}' (expected <org>:<id>)`);
    continue;
  }
  const org = pair.slice(0, idx);
  const productId = pair.slice(idx + 1);
  console.log(`\n=== ${org} / ${productId} ===`);
  const result = await tool.exec({ targetOrg: org, productId });
  for (const c of result.content) {
    console.log(c.text);
  }
  if (result.isError) {
    console.error(`(error reported by tool for ${org}/${productId})`);
  }
}
