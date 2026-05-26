#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTools } from "./tools/index.js";

const PACKAGE_NAME = "@kccs/comms-cloud-mcp";
const PACKAGE_VERSION = "0.1.0-alpha.0";

async function main(): Promise<void> {
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });

  const tools = createTools();
  for (const tool of tools) {
    const config = tool.getConfig();
    server.tool(
      tool.getName(),
      config.description,
      config.inputSchema.shape,
      async (args) => tool.exec(args as Record<string, unknown>)
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error in MCP server:", err);
  process.exit(1);
});
