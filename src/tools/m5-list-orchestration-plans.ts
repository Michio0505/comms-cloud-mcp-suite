import { z } from "zod";
import type { Connection } from "@salesforce/core";
import { BaseTool, type CallResult } from "./base-tool.js";
import { sObjectExists, isValidSalesforceId } from "../utils/sobject.js";

const inputSchema = z.object({
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
        "Standard NS (Core / Revenue Cloud) does not currently expose an equivalent " +
        "Orchestration Plan Definition model; on Core-only orgs this tool returns an " +
        "explanatory error."
    ),
  planId: z
    .string()
    .optional()
    .describe(
      "Optional Salesforce ID to scope the result to a single OrchestrationPlanDefinition. " +
        "If omitted, all plans visible to the running user are returned."
    ),
  planLimit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(
      "Maximum number of plans returned. Defaults to 100; use a smaller value " +
        "for quick inspection of large orgs."
    ),
});

type Input = z.infer<typeof inputSchema>;

// ---- Result types ---------------------------------------------------------

type OrchestrationItemSummary = {
  id: string;
  name: string;
  recordType: string | null;
  key: string | null;
  scope: string | null;
  systemInterfaceId: string | null;
  subPlanDefinitionId: string | null;
  rollBackPlanDefinitionId: string | null;
  amendPlanDefinitionId: string | null;
  isPointOfNoReturn: boolean | null;
  timeoutMs: number | null;
  numberOfRetries: number | null;
  requestOmniDataTransformName: string | null;
  responseOmniDataTransformName: string | null;
};

type OrchestrationPlanSummary = {
  id: string;
  name: string;
  scope: string | null;
  showOrder: number | null;
  isSchedulingEnabled: boolean | null;
  items: OrchestrationItemSummary[];
};

type OrchestrationPlansResult = {
  plans: OrchestrationPlanSummary[];
  meta: {
    planCount: number;
    totalItemCount: number;
    recordTypeBreakdown: Record<string, number>;
    truncated: boolean;
  };
};

// ---- Tool -----------------------------------------------------------------

export class ListOrchestrationPlansTool extends BaseTool {
  getName(): string {
    return "list_orchestration_plans";
  }

  getConfig() {
    return {
      description:
        "Lists Vlocity Order Management plan definitions (vlocity_cmt__OrchestrationPlanDefinition__c) " +
        "with their step definitions (vlocity_cmt__OrchestrationItemDefinition__c) nested under each. " +
        "RecordType.DeveloperName is preserved verbatim so unfamiliar step types (e.g. PullEvent, " +
        "SubPlan, plus future additions) are not silently dropped. " +
        "Vlocity-only: on Core / Revenue Cloud orgs the equivalent objects do not exist today " +
        "and an explanatory error is returned. Use namespace_detect first to confirm the org type.",
      inputSchema,
    };
  }

  async exec(args: Record<string, unknown>): Promise<CallResult> {
    try {
      const parsed: Input = inputSchema.parse(args);

      if (parsed.planId && !isValidSalesforceId(parsed.planId)) {
        return errorResult(
          `Invalid planId '${parsed.planId}'. Expected a 15- or 18-character Salesforce ID.`
        );
      }

      const conn = await this.ctx.sfClient.getConnection(parsed.targetOrg);
      const requestedMode = parsed.mode ?? "auto";
      const planLimit = parsed.planLimit ?? 100;

      const hasPlanDef = await sObjectExists(
        conn,
        "vlocity_cmt__OrchestrationPlanDefinition__c"
      );
      const hasStandardPCM = await sObjectExists(conn, "ProductCatalog");

      const detectedNamespace = hasPlanDef && hasStandardPCM
        ? "hybrid"
        : hasPlanDef
          ? "vlocity_cmt"
          : hasStandardPCM
            ? "standard"
            : "none";

      if (!hasPlanDef) {
        return errorResult(
          "Vlocity IOM objects not available in this org. " +
            "vlocity_cmt__OrchestrationPlanDefinition__c does not exist here. " +
            "Core (Revenue Cloud / Comms-on-Core) uses Dynamic Revenue Orchestrator " +
            "(FulfillmentWorkspace / FulfillmentRequest), which is not yet covered by " +
            "this tool. See docs/NAMESPACE_TRANSITION.md §2.4 for the broader OM picture."
        );
      }

      const plans = await queryOrchestrationPlans(conn, parsed.planId, planLimit);

      // RecordType breakdown across all items, defensively counting unknown
      // types (e.g. PullEvent / SubPlan, plus anything we have not seen yet).
      const recordTypeBreakdown: Record<string, number> = {};
      let totalItemCount = 0;
      for (const plan of plans) {
        for (const item of plan.items) {
          totalItemCount += 1;
          const key = item.recordType ?? "(unknown)";
          recordTypeBreakdown[key] = (recordTypeBreakdown[key] ?? 0) + 1;
        }
      }

      const result: Record<string, unknown> = {
        detectedNamespace,
        requestedMode,
        queried: ["vlocity_cmt"],
        details: {
          orgUsername: conn.getUsername(),
          instanceUrl: conn.instanceUrl,
          apiVersion: conn.getApiVersion(),
        },
        vlocity_cmt: {
          plans,
          meta: {
            planCount: plans.length,
            totalItemCount,
            recordTypeBreakdown,
            truncated: plans.length >= planLimit,
          },
        } satisfies OrchestrationPlansResult,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Error listing orchestration plans: ${msg}`);
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

type ItemRow = {
  Id: string;
  Name: string;
  RecordType: { DeveloperName: string | null } | null;
  vlocity_cmt__Key__c: string | null;
  vlocity_cmt__Scope__c: string | null;
  vlocity_cmt__SystemInterfaceId__c: string | null;
  vlocity_cmt__SubPlanDefinitionId__c: string | null;
  vlocity_cmt__RollBackPlanDefinitionId__c: string | null;
  vlocity_cmt__AmendPlanDefinitionId__c: string | null;
  vlocity_cmt__IsPointOfNoReturn__c: boolean | null;
  vlocity_cmt__TimeoutMs__c: number | null;
  vlocity_cmt__NumberOfRetries__c: number | null;
  vlocity_cmt__RequestOmniDataTransformName__c: string | null;
  vlocity_cmt__ResponseOmniDataTransformName__c: string | null;
};

type PlanRow = {
  Id: string;
  Name: string;
  vlocity_cmt__Scope__c: string | null;
  vlocity_cmt__ShowOrder__c: number | null;
  vlocity_cmt__IsSchedulingEnabled__c: boolean | null;
  vlocity_cmt__OrchestrationItemDefinitions__r: {
    records: ItemRow[];
  } | null;
};

async function queryOrchestrationPlans(
  conn: Connection,
  planId: string | undefined,
  planLimit: number
): Promise<OrchestrationPlanSummary[]> {
  // Note: vlocity_cmt__OrchestrationPlanDefinition__c does NOT have an
  // IsActive__c field (confirmed against vlocity-cmt-org and hybrid-org).
  // "Active vs inactive plans" is not a concept at this level — items can
  // carry an activation/condition state, but the plan definition itself is
  // simply present or absent.
  let soql =
    `SELECT Id, Name, ` +
    `vlocity_cmt__Scope__c, vlocity_cmt__ShowOrder__c, ` +
    `vlocity_cmt__IsSchedulingEnabled__c, ` +
    `( SELECT Id, Name, RecordType.DeveloperName, ` +
    `vlocity_cmt__Key__c, vlocity_cmt__Scope__c, ` +
    `vlocity_cmt__SystemInterfaceId__c, ` +
    `vlocity_cmt__SubPlanDefinitionId__c, ` +
    `vlocity_cmt__RollBackPlanDefinitionId__c, ` +
    `vlocity_cmt__AmendPlanDefinitionId__c, ` +
    `vlocity_cmt__IsPointOfNoReturn__c, vlocity_cmt__TimeoutMs__c, ` +
    `vlocity_cmt__NumberOfRetries__c, ` +
    `vlocity_cmt__RequestOmniDataTransformName__c, ` +
    `vlocity_cmt__ResponseOmniDataTransformName__c ` +
    `FROM vlocity_cmt__OrchestrationItemDefinitions__r ) ` +
    `FROM vlocity_cmt__OrchestrationPlanDefinition__c`;

  if (planId) {
    soql += ` WHERE Id = '${planId}'`;
  }
  soql += ` ORDER BY vlocity_cmt__ShowOrder__c NULLS LAST, Name LIMIT ${planLimit}`;

  const resp = await conn.query<PlanRow>(soql);

  return resp.records.map((p) => ({
    id: p.Id,
    name: p.Name,
    scope: p.vlocity_cmt__Scope__c,
    showOrder: p.vlocity_cmt__ShowOrder__c,
    isSchedulingEnabled: p.vlocity_cmt__IsSchedulingEnabled__c,
    items: (p.vlocity_cmt__OrchestrationItemDefinitions__r?.records ?? []).map(
      (i) => ({
        id: i.Id,
        name: i.Name,
        recordType: i.RecordType?.DeveloperName ?? null,
        key: i.vlocity_cmt__Key__c,
        scope: i.vlocity_cmt__Scope__c,
        systemInterfaceId: i.vlocity_cmt__SystemInterfaceId__c,
        subPlanDefinitionId: i.vlocity_cmt__SubPlanDefinitionId__c,
        rollBackPlanDefinitionId: i.vlocity_cmt__RollBackPlanDefinitionId__c,
        amendPlanDefinitionId: i.vlocity_cmt__AmendPlanDefinitionId__c,
        isPointOfNoReturn: i.vlocity_cmt__IsPointOfNoReturn__c,
        timeoutMs: i.vlocity_cmt__TimeoutMs__c,
        numberOfRetries: i.vlocity_cmt__NumberOfRetries__c,
        requestOmniDataTransformName:
          i.vlocity_cmt__RequestOmniDataTransformName__c,
        responseOmniDataTransformName:
          i.vlocity_cmt__ResponseOmniDataTransformName__c,
      })
    ),
  }));
}
