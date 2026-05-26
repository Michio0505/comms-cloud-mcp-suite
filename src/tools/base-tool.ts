import { z } from "zod";
import type { SfClient } from "../sf-client.js";

/**
 * Tool runtime context provided by the host.
 * Shape mirrors `@salesforce/mcp-provider-api`'s `Services` so that
 * a future plug-in adapter can pass `Services.getOrgService()` directly.
 */
export interface ToolContext {
  sfClient: SfClient;
}

export type CallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Abstract base class for all KCCS Comms Cloud MCP tools.
 * Mirrors the shape of `@salesforce/mcp-provider-api`'s `McpTool` so the
 * codebase can be wrapped as an `McpProvider` plug-in later (see Step 0 memo).
 */
export abstract class BaseTool {
  protected ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  abstract getName(): string;

  abstract getConfig(): {
    description: string;
    inputSchema: z.ZodObject<z.ZodRawShape>;
  };

  abstract exec(args: Record<string, unknown>): Promise<CallResult>;
}
