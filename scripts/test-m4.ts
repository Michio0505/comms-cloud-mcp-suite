/**
 * Smoke test for M4 get_decomposition_map.
 *
 * Usage:
 *   npx tsx scripts/test-m4.ts <org-alias>:<product-id> [<org-alias>:<product-id> ...]
 *
 * Example:
 *   npx tsx scripts/test-m4.ts vlocity-cmt-org:01tak00000O7sMGAAZ
 */
import { SfClient } from "../src/sf-client.js";
import { GetDecompositionMapTool } from "../src/tools/m4-get-decomposition-map.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "Usage: tsx scripts/test-m4.ts <org-alias>:<product-id> [<org-alias>:<product-id> ...]"
  );
  process.exit(1);
}

const sfClient = new SfClient();
const tool = new GetDecompositionMapTool({ sfClient });

for (const arg of args) {
  const [org, productId] = arg.split(":");
  if (!org || !productId) {
    console.error(`Skipping invalid arg '${arg}' (expected <alias>:<id>)`);
    continue;
  }
  console.log(`\n=== ${org} / ${productId} ===`);
  const result = await tool.exec({ targetOrg: org, productId });
  for (const c of result.content) {
    console.log(c.text);
  }
  if (result.isError) {
    console.error(`(error reported by tool for ${org}/${productId})`);
  }
}
