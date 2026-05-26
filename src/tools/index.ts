import { SfClient } from "../sf-client.js";
import type { BaseTool, ToolContext } from "./base-tool.js";
import { NamespaceDetectTool } from "./m1-namespace-detect.js";
import { ListProductsTool } from "./m2-list-products.js";
import { GetProductDetailsTool } from "./m3-get-product-details.js";
import { GetDecompositionMapTool } from "./m4-get-decomposition-map.js";
import { ListOrchestrationPlansTool } from "./m5-list-orchestration-plans.js";

export function createTools(): BaseTool[] {
  const ctx: ToolContext = {
    sfClient: new SfClient(),
  };

  return [
    new NamespaceDetectTool(ctx),
    new ListProductsTool(ctx),
    new GetProductDetailsTool(ctx),
    new GetDecompositionMapTool(ctx),
    new ListOrchestrationPlansTool(ctx),
  ];
}
