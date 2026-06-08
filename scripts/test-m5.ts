/**
 * Smoke test for M5 list_orchestration_plans.
 *
 * Usage:
 *   npx tsx scripts/test-m5.ts <org-alias> [<org-alias> ...]
 *
 * Example:
 *   npx tsx scripts/test-m5.ts vlocity-cmt-org comms-on-core2025 hybrid-org
 */
import { SfClient } from "../src/sf-client.js";
import { ListOrchestrationPlansTool } from "../src/tools/m5-list-orchestration-plans.js";

const orgs = process.argv.slice(2);
if (orgs.length === 0) {
  console.error(
    "Usage: tsx scripts/test-m5.ts <org-alias-1> [<org-alias-2> ...]"
  );
  process.exit(1);
}

const sfClient = new SfClient();
const tool = new ListOrchestrationPlansTool({ sfClient });

for (const org of orgs) {
  console.log(`\n=== ${org} ===`);
  const result = await tool.exec({ targetOrg: org, planLimit: 20 });
  for (const c of result.content) {
    console.log(c.text);
  }
  if (result.isError) {
    console.error(`(error reported by tool for ${org})`);
  }
}
