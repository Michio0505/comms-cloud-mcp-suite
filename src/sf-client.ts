import { Org, type Connection } from "@salesforce/core";

/**
 * Thin wrapper around @salesforce/core to resolve a Connection from an alias or username.
 * Caches connections per alias for the lifetime of the MCP server process.
 *
 * Designed to be compatible with the shape of `OrgService.getConnection()`
 * from `@salesforce/mcp-provider-api`, so we can convert this MCP into
 * a plug-in later without rewriting tool code.
 */
export class SfClient {
  private connections = new Map<string, Connection>();

  async getConnection(aliasOrUsername?: string): Promise<Connection> {
    const key = aliasOrUsername ?? "__default__";

    const cached = this.connections.get(key);
    if (cached) return cached;

    const org = await Org.create({ aliasOrUsername });
    const conn = org.getConnection();

    this.connections.set(key, conn);
    return conn;
  }
}
