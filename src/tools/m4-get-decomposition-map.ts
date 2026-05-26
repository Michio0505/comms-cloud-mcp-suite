import { z } from "zod";
import type { Connection } from "@salesforce/core";
import { BaseTool, type CallResult } from "./base-tool.js";
import { sObjectExists, isValidSalesforceId } from "../utils/sobject.js";

const inputSchema = z.object({
  productId: z
    .string()
    .describe(
      "Salesforce ID of the Product2 record whose decomposition relationships you want to inspect (15- or 18-character ID)."
    ),
  targetOrg: z
    .string()
    .optional()
    .describe(
      "Target Salesforce org alias or username (as known to the Salesforce CLI). " +
        "If omitted, the default target org is used."
    ),
  mode: z
    .enum(["auto", "vlocity_cmt"])
    .optional()
    .describe(
      "Which Comms Cloud model to query. 'auto' (default) uses Vlocity if available. " +
        "'vlocity_cmt' forces Vlocity (fails if not present). " +
        "Standard NS (Core / Revenue Cloud) does not have an equivalent " +
        "vlocity_cmt__DecompositionRelationship__c object today; on Core-only orgs " +
        "this tool returns an explanatory error."
    ),
});

type Input = z.infer<typeof inputSchema>;

// ---- Result types ---------------------------------------------------------

type DecompositionRelationshipSummary = {
  id: string;
  name: string;
  sourceProductId: string | null;
  sourceProductName: string | null;
  destinationProductId: string | null;
  destinationProductName: string | null;
  destinationMinQuantity: number | null;
  destinationMaxQuantity: number | null;
  destinationDefaultQuantity: number | null;
  sourceMinQuantity: number | null;
  sourceMaxQuantity: number | null;
  sourceDefaultQuantity: number | null;
  conditionData: string | null;
  mappingsData: string | null;
  xorGroup: string | null;
  priority: number | null;
};

type DecompositionMapResult = {
  productId: string;
  asSource: DecompositionRelationshipSummary[];
  asDestination: DecompositionRelationshipSummary[];
  totalRelationships: number;
};

// ---- Tool -----------------------------------------------------------------

export class GetDecompositionMapTool extends BaseTool {
  getName(): string {
    return "get_decomposition_map";
  }

  getConfig() {
    return {
      description:
        "Returns the Vlocity Order Management decomposition map for a single Product2: " +
        "all vlocity_cmt__DecompositionRelationship__c rows where the product appears as " +
        "either the source (commercial / parent) or the destination (technical / child). " +
        "Useful for understanding how a commercial product decomposes into technical " +
        "services and resources, as a precondition for Migration discussions. " +
        "Vlocity-only: on Core / Revenue Cloud orgs the equivalent objects do not exist " +
        "today and an explanatory error is returned.",
      inputSchema,
    };
  }

  async exec(args: Record<string, unknown>): Promise<CallResult> {
    try {
      const parsed: Input = inputSchema.parse(args);

      if (!isValidSalesforceId(parsed.productId)) {
        return errorResult(
          `Invalid productId '${parsed.productId}'. Expected a 15- or 18-character Salesforce ID.`
        );
      }

      const conn = await this.ctx.sfClient.getConnection(parsed.targetOrg);
      const requestedMode = parsed.mode ?? "auto";

      const hasDecomposition = await sObjectExists(
        conn,
        "vlocity_cmt__DecompositionRelationship__c"
      );
      const hasStandardPCM = await sObjectExists(conn, "ProductCatalog");

      const detectedNamespace = hasDecomposition && hasStandardPCM
        ? "hybrid"
        : hasDecomposition
          ? "vlocity_cmt"
          : hasStandardPCM
            ? "standard"
            : "none";

      if (!hasDecomposition) {
        // Core-only or no-Comms org. Decomposition is Vlocity-specific today.
        return errorResult(
          "Vlocity IOM objects not available in this org. " +
            "vlocity_cmt__DecompositionRelationship__c does not exist here. " +
            "Core (Revenue Cloud / Comms-on-Core) uses Dynamic Revenue Orchestrator " +
            "(FulfillmentWorkspace / FulfillmentRequest), which is not yet covered by " +
            "this tool. See docs/NAMESPACE_TRANSITION.md §2.4 for the broader OM picture."
        );
      }

      const relationships = await queryDecompositionRelationships(
        conn,
        parsed.productId
      );

      const asSource: DecompositionRelationshipSummary[] = [];
      const asDestination: DecompositionRelationshipSummary[] = [];

      for (const rel of relationships) {
        // The same Product2 can in theory be both source and destination of
        // the same relationship row; we partition by which slot matches.
        if (rel.sourceProductId === parsed.productId) {
          asSource.push(rel);
        }
        if (rel.destinationProductId === parsed.productId) {
          asDestination.push(rel);
        }
      }

      const result: Record<string, unknown> = {
        detectedNamespace,
        requestedMode,
        queried: ["vlocity_cmt"],
        productId: parsed.productId,
        details: {
          orgUsername: conn.getUsername(),
          instanceUrl: conn.instanceUrl,
          apiVersion: conn.getApiVersion(),
        },
        vlocity_cmt: {
          productId: parsed.productId,
          asSource,
          asDestination,
          totalRelationships: relationships.length,
        } satisfies DecompositionMapResult,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Error retrieving decomposition map: ${msg}`);
    }
  }
}

// ---- Helpers --------------------------------------------------------------

function errorResult(message: string): CallResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

type DecompositionRow = {
  Id: string;
  Name: string;
  vlocity_cmt__SourceProductId__c: string | null;
  vlocity_cmt__SourceProductId__r: { Name: string | null } | null;
  vlocity_cmt__DestinationProductId__c: string | null;
  vlocity_cmt__DestinationProductId__r: { Name: string | null } | null;
  vlocity_cmt__DestinationMinQuantity__c: number | null;
  vlocity_cmt__DestinationMaxQuantity__c: number | null;
  vlocity_cmt__DestinationDefaultQuantity__c: number | null;
  vlocity_cmt__SourceMinQuantity__c: number | null;
  vlocity_cmt__SourceMaxQuantity__c: number | null;
  vlocity_cmt__SourceDefaultQuantity__c: number | null;
  vlocity_cmt__ConditionData__c: string | null;
  vlocity_cmt__MappingsData__c: string | null;
  vlocity_cmt__XORGroup__c: string | null;
  vlocity_cmt__Priority__c: number | null;
};

async function queryDecompositionRelationships(
  conn: Connection,
  productId: string
): Promise<DecompositionRelationshipSummary[]> {
  const soql =
    `SELECT Id, Name, ` +
    `vlocity_cmt__SourceProductId__c, vlocity_cmt__SourceProductId__r.Name, ` +
    `vlocity_cmt__DestinationProductId__c, vlocity_cmt__DestinationProductId__r.Name, ` +
    `vlocity_cmt__DestinationMinQuantity__c, vlocity_cmt__DestinationMaxQuantity__c, ` +
    `vlocity_cmt__DestinationDefaultQuantity__c, ` +
    `vlocity_cmt__SourceMinQuantity__c, vlocity_cmt__SourceMaxQuantity__c, ` +
    `vlocity_cmt__SourceDefaultQuantity__c, ` +
    // Note: vlocity_cmt__DecompositionRelationship__c does NOT have an
    // IsActive__c field (confirmed against vlocity-cmt-org). Relationships
    // are filtered at runtime by conditions / priority rather than an
    // active flag at the row level.
    `vlocity_cmt__ConditionData__c, vlocity_cmt__MappingsData__c, ` +
    `vlocity_cmt__XORGroup__c, vlocity_cmt__Priority__c ` +
    `FROM vlocity_cmt__DecompositionRelationship__c ` +
    `WHERE vlocity_cmt__SourceProductId__c = '${productId}' ` +
    `OR vlocity_cmt__DestinationProductId__c = '${productId}' ` +
    `ORDER BY vlocity_cmt__Priority__c NULLS LAST`;

  const resp = await conn.query<DecompositionRow>(soql);

  return resp.records.map((r) => ({
    id: r.Id,
    name: r.Name,
    sourceProductId: r.vlocity_cmt__SourceProductId__c,
    sourceProductName: r.vlocity_cmt__SourceProductId__r?.Name ?? null,
    destinationProductId: r.vlocity_cmt__DestinationProductId__c,
    destinationProductName: r.vlocity_cmt__DestinationProductId__r?.Name ?? null,
    destinationMinQuantity: r.vlocity_cmt__DestinationMinQuantity__c,
    destinationMaxQuantity: r.vlocity_cmt__DestinationMaxQuantity__c,
    destinationDefaultQuantity: r.vlocity_cmt__DestinationDefaultQuantity__c,
    sourceMinQuantity: r.vlocity_cmt__SourceMinQuantity__c,
    sourceMaxQuantity: r.vlocity_cmt__SourceMaxQuantity__c,
    sourceDefaultQuantity: r.vlocity_cmt__SourceDefaultQuantity__c,
    conditionData: r.vlocity_cmt__ConditionData__c,
    mappingsData: r.vlocity_cmt__MappingsData__c,
    xorGroup: r.vlocity_cmt__XORGroup__c,
    priority: r.vlocity_cmt__Priority__c,
  }));
}
