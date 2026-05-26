import { z } from "zod";
import type { Connection } from "@salesforce/core";
import { BaseTool, type CallResult } from "./base-tool.js";

const inputSchema = z.object({
  targetOrg: z
    .string()
    .optional()
    .describe(
      "Target Salesforce org alias or username (as known to the Salesforce CLI). " +
        "If omitted, the default target org is used."
    ),
});

type Input = z.infer<typeof inputSchema>;

export type Namespace = "vlocity_cmt" | "standard" | "hybrid" | "none";

/**
 * Probe objects we use to fingerprint each namespace.
 * - Vlocity: ObjectClass__c (older Vlocity CMT) and ObjectType__c (newer) and Catalog__c.
 *   Catalog__c is the most consistently present across versions, so it's the
 *   primary signal. The rest are secondary signals included in the result for
 *   diagnostic value.
 * - Standard NS: ProductCatalog + ProductCategory + AttributeDefinition cover the
 *   core PCM (Product Catalog Management) data model present in
 *   Revenue Cloud / Comms-on-Core orgs.
 */
const VLOCITY_PROBE_OBJECTS = [
  "vlocity_cmt__Catalog__c",
  "vlocity_cmt__ObjectClass__c",
  "vlocity_cmt__ObjectType__c",
] as const;

const STANDARD_COMMS_PROBE_OBJECTS = [
  "ProductCatalog",
  "ProductCategory",
  "AttributeDefinition",
] as const;

export class NamespaceDetectTool extends BaseTool {
  getName(): string {
    return "namespace_detect";
  }

  getConfig() {
    return {
      description:
        "Detects which Salesforce Communications Cloud namespace is present in the target org. " +
        "Returns one of: 'vlocity_cmt' (Vlocity CMT package installed), " +
        "'standard' (Core / Revenue Cloud PCM standard objects), " +
        "'hybrid' (both present), or 'none' (no Comms Cloud signature). " +
        "Subsequent tools (list_products, get_product_details) branch their SOQL/REST " +
        "behavior based on this result.",
      inputSchema,
    };
  }

  async exec(args: Record<string, unknown>): Promise<CallResult> {
    try {
      const parsed: Input = inputSchema.parse(args);
      const conn = await this.ctx.sfClient.getConnection(parsed.targetOrg);

      const vlocityResults = await Promise.all(
        VLOCITY_PROBE_OBJECTS.map((o) => objectExists(conn, o))
      );
      const standardResults = await Promise.all(
        STANDARD_COMMS_PROBE_OBJECTS.map((o) => objectExists(conn, o))
      );

      // Heuristic:
      //  - Vlocity present if Catalog__c exists (primary signal).
      //  - Standard Comms present if all 3 core PCM objects exist
      //    (a DE with just Product2 should NOT count as 'standard').
      const hasVlocity = vlocityResults[0]; // Catalog__c is index 0
      const hasStandardComms = standardResults.every(Boolean);

      let namespace: Namespace;
      if (hasVlocity && hasStandardComms) namespace = "hybrid";
      else if (hasVlocity) namespace = "vlocity_cmt";
      else if (hasStandardComms) namespace = "standard";
      else namespace = "none";

      const result = {
        namespace,
        details: {
          orgUsername: conn.getUsername(),
          instanceUrl: conn.instanceUrl,
          apiVersion: conn.getApiVersion(),
          vlocity: Object.fromEntries(
            VLOCITY_PROBE_OBJECTS.map((o, i) => [o, vlocityResults[i]])
          ),
          standard: Object.fromEntries(
            STANDARD_COMMS_PROBE_OBJECTS.map((o, i) => [o, standardResults[i]])
          ),
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Error detecting namespace: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
}

async function objectExists(conn: Connection, sobjectName: string): Promise<boolean> {
  try {
    await conn.sobject(sobjectName).describe();
    return true;
  } catch {
    return false;
  }
}
