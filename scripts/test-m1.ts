/**
 * Smoke test for M1 namespace_detect.
 *
 * Usage:
 *   npx tsx scripts/test-m1.ts <org-alias> [<org-alias> ...]
 *
 * Example:
 *   npx tsx scripts/test-m1.ts vlocity-cmt-org comms-on-core2025 hybrid-org
 */
import { SfClient } from "../src/sf-client.js";
import { NamespaceDetectTool } from "../src/tools/m1-namespace-detect.js";

const orgs = process.argv.slice(2);
if (orgs.length === 0) {
  console.error(
    "Usage: tsx scripts/test-m1.ts <org-alias-1> [<org-alias-2> ...]"
  );
  process.exit(1);
}

const sfClient = new SfClient();
const tool = new NamespaceDetectTool({ sfClient });

for (const org of orgs) {
  console.log(`\n=== ${org} ===`);
  const result = await tool.exec({ targetOrg: org });
  for (const c of result.content) {
    console.log(c.text);
  }
  if (result.isError) {
    console.error(`(error reported by tool for ${org})`);
  }
}
