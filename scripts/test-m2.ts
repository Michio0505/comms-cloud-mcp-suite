/**
 * Smoke test for M2 list_products.
 *
 * Usage:
 *   npx tsx scripts/test-m2.ts <org-alias> [<org-alias> ...]
 *
 * Example:
 *   npx tsx scripts/test-m2.ts vlocity-cmt-org comms-on-core2025 kyocera-comms
 */
import { SfClient } from "../src/sf-client.js";
import { ListProductsTool } from "../src/tools/m2-list-products.js";

const orgs = process.argv.slice(2);
if (orgs.length === 0) {
  console.error(
    "Usage: tsx scripts/test-m2.ts <org-alias-1> [<org-alias-2> ...]"
  );
  process.exit(1);
}

const sfClient = new SfClient();
const tool = new ListProductsTool({ sfClient });

for (const org of orgs) {
  console.log(`\n=== ${org} ===`);
  const result = await tool.exec({ targetOrg: org, productLimit: 20 });
  for (const c of result.content) {
    console.log(c.text);
  }
  if (result.isError) {
    console.error(`(error reported by tool for ${org})`);
  }
}
