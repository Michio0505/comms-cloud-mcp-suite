# Architecture — Comms Cloud MCP Server

> A view from the middle: where [`DESIGN.md`](./DESIGN.md) explains *how*
> each individual tool works and [`NAMESPACE_TRANSITION.md`](./NAMESPACE_TRANSITION.md)
> explains *why* the namespace landscape looks the way it does, this
> document describes *how the whole server is put together* and how it
> is meant to fit alongside the broader Salesforce MCP ecosystem.

---

## 1. Positioning

This is a small MCP server. Roughly 2,000 lines of TypeScript across five
tools, all read-only, all focused on Salesforce Communications Cloud
inspection. It is deliberately designed to **sit beside** the official
Salesforce MCP servers rather than try to replace them.

In practice an LLM-based client (Claude Desktop, Cursor, Windsurf, …) is
configured with several MCP servers at once. For a Comms-aware
developer that looks something like:

```
LLM client
   ├── @salesforce/mcp                ← official Salesforce DX MCP
   │     (metadata, data, testing, devops, ...)
   ├── @salesforce/omnistudio-mcp     ← official OmniStudio authoring MCP
   │     (FlexCard / OmniScript / DataMapper)
   └── this server                    ← Comms Cloud catalog / OM inspection
         (namespace_detect, list_products, get_product_details)
```

Each server covers a different surface; the LLM picks the right tool
for the question being asked. This document explains how this third
server is built so reviewers can judge how cleanly it would slot
alongside whatever direction Salesforce takes officially.

---

## 2. System layers

```
┌──────────────────────────────────────────────────────┐
│  MCP protocol layer                                  │
│  (stdio transport, ListTools / CallTool dispatch)    │
│  → src/server.ts, @modelcontextprotocol/sdk          │
├──────────────────────────────────────────────────────┤
│  Tool layer                                          │
│  (one class per tool, shared base, registry)         │
│  → src/tools/base-tool.ts                            │
│    src/tools/index.ts                                │
│    src/tools/m{1,2,3}-*.ts                           │
├──────────────────────────────────────────────────────┤
│  Salesforce client layer                             │
│  (alias-to-Connection resolution, connection cache)  │
│  → src/sf-client.ts, @salesforce/core                │
├──────────────────────────────────────────────────────┤
│  Org (external)                                      │
│  Reached via Salesforce CLI's existing auth state    │
└──────────────────────────────────────────────────────┘
```

The boundaries are intentional:

- **MCP protocol layer** never touches Salesforce directly. It accepts
  `CallTool` requests, looks up the tool by name, and forwards
  validated arguments. It speaks stdio so it integrates with any MCP
  client without configuration.
- **Tool layer** never touches the network directly. Each tool
  receives a `ToolContext` carrying an `SfClient` instance; from there
  the tool composes SOQL but does not manage connections.
- **Salesforce client layer** never knows about the MCP protocol. It
  resolves aliases to `Connection` instances via `@salesforce/core`
  and caches them per process. Replacing this layer (e.g. to talk to
  a different Salesforce auth backend) would not require touching the
  tools.

This is a classic three-layer separation. It pays off the first time
you want to test a tool in isolation: `scripts/test-m1.ts`,
`test-m2.ts`, `test-m3.ts` import a tool class and an `SfClient`
directly, with no MCP transport in the loop.

---

## 3. Cross-cutting design choices

### 3.1 Namespace-transparent dispatch

The most important design decision in this server is that the choice
of namespace (`vlocity_cmt` vs Core / Industries vs hybrid) is made
**inside the server, not by the caller**. Every tool runs the same
detection logic (described in [`DESIGN.md`](./DESIGN.md) §2.1) and
branches its SOQL strategy accordingly.

The caller may override with an explicit `mode` argument when needed,
but the default `mode: "auto"` is what almost every interactive use
will hit. This means an LLM does not have to "remember" which org is
which type — it just calls the tool and the tool figures it out.

### 3.2 Standalone server vs MCP provider plug-in

Salesforce ships an internal package, `@salesforce/mcp-provider-api`,
that lets third-party packages register `McpTool` implementations into
the official `@salesforce/mcp` server. Because of where Salesforce
positions that API today (the README marks it "internal use only"),
this server is built as a **standalone MCP server** instead.

That choice was *not* a rejection of the plug-in model — it was
chosen to keep the interface shape *compatible* with it. See
[§6.3 Future Salesforce ecosystem integration](#63-future-salesforce-ecosystem-integration).

### 3.3 Authentication delegated to the Salesforce CLI

The server has no environment variables for credentials, no `.env`
file, no token storage. It calls into `@salesforce/core` with an alias
or username; that library picks up whatever the Salesforce CLI
(`sf org login web`) has already authenticated.

Two consequences:

- A reviewer can pull the repo, run `npm install`, point the MCP
  client at `dist/server.js`, and use it against any org their CLI
  already knows. No secrets travel through this repository or its
  configuration.
- The server inherits the CLI's session expiry behavior. Stale
  sessions surface as Salesforce errors which propagate to the
  caller verbatim.

### 3.4 Uniform tool interface

Every tool follows the same shape (described in detail in
[`DESIGN.md`](./DESIGN.md) §2.5):

- Inputs declared via `zod` (published as a JSON schema by the MCP
  server)
- Single text content block returned with pretty-printed JSON
- `isError: true` for tool-level failures with a human-readable
  message; never a half-filled payload

That uniformity is what lets `BaseTool` exist as an abstract class
and what lets `tools/index.ts` register a tool with one line per
addition.

---

## 4. Module structure

```
src/
├── server.ts              MCP entry point (stdio).
│                          Loads tools, wires the SDK.
│
├── sf-client.ts           Per-process Connection cache.
│                          One method: getConnection(alias?).
│
├── tools/
│   ├── base-tool.ts       Abstract class. Defines getName(),
│   │                      getConfig(), exec() and the result shape.
│   ├── index.ts           Registry: createTools() returns the
│   │                      BaseTool[] that server.ts iterates.
│   ├── m1-namespace-detect.ts
│   ├── m2-list-products.ts
│   └── m3-get-product-details.ts
│
└── utils/
    └── sobject.ts         sObjectExists(conn, name)
                            and isValidSalesforceId(id).

scripts/
├── test-m1.ts             Direct (non-MCP) smoke tests
├── test-m2.ts             that exercise a tool against one
└── test-m3.ts             or more orgs from the CLI.
```

`src/utils/` exists for genuinely shared helpers only. So far there
is just one file with two functions; if a third tool category lands
that needs different helpers, splitting into `src/utils/<topic>.ts`
is the natural next move.

`scripts/` is deliberately *not* part of the published package's
runtime — it is for development and verification. Type-checked the
same way, but never imported by the server.

---

## 5. Dependencies and their roles

The runtime dependency list is intentionally short:

| Dependency | Role | Why |
|------------|------|-----|
| `@modelcontextprotocol/sdk` | MCP protocol implementation (transport, request handlers, schema publishing) | Official SDK; following its surface keeps this server compatible with all MCP clients |
| `@salesforce/core` | Org / Connection resolution, auth state reuse from CLI | The canonical way to access an authenticated org without re-implementing OAuth |
| `zod` | Tool input schema definition, runtime validation, JSON-schema generation | Same library used internally by the MCP SDK; one source of truth for argument shapes |
| `dotenv` | (currently unused, reserved) | Kept in dependencies as a placeholder for future env-loading needs; can be removed if not adopted |
| `lodash`, `axios`, `playwright`, ... | **NOT used** | Some related MCP servers depend on these; this server intentionally does not, to keep the install surface small |

Dev dependencies (`typescript`, `tsx`, `@types/node`) are limited to
what the build and the smoke-test scripts need.

The smaller the dependency surface, the easier this server is to
audit and the less it can drift from official Salesforce libraries.

---

## 6. Extension points

This section explains where the server is meant to grow.

### 6.1 Adding a new tool

The procedure is uniform:

1. Implement a class extending `BaseTool` in
   `src/tools/<name>.ts`.
2. Define inputs via `zod`, write `getName()`, `getConfig()`, and
   `exec()`.
3. Add one line to `src/tools/index.ts` to register it.
4. Add a thin smoke script in `scripts/test-<name>.ts` if useful.

No other file needs to change. The server's `ListTools` /
`CallTool` handlers iterate the registry, so a new tool appears
automatically.

### 6.2 Future Salesforce ecosystem integration

This is the integration shape worth highlighting up front, because
it is the most consequential for anyone aligning Salesforce's
official direction with what is in this repo.

`@salesforce/mcp-provider-api` defines two abstract classes:

```typescript
abstract class McpProvider {
  getName(): string;
  provideTools(services: Services): Promise<McpTool[]>;
  // ...
}

abstract class McpTool {
  getName(): string;
  getReleaseState(): ReleaseState;
  getToolsets(): Toolset[];
  getConfig(): McpToolConfig;
  exec(args, extra): CallToolResult;
}
```

The `BaseTool` class in this repository is intentionally **shaped
the same way**. Method names, the role of `getName()` / `getConfig()`
/ `exec()`, and the result envelope all match. The differences are:

- This server constructs tools with a private `ToolContext` (carrying
  `SfClient`), whereas `@salesforce/mcp-provider-api` passes a
  framework-provided `Services` object that includes an `OrgService`.
  An adapter class that wraps `SfClient.getConnection(...)` around
  `Services.getOrgService().getConnection(username)` is short.
- `McpTool.getReleaseState()` and `getToolsets()` would need to be
  declared (GA vs non-GA, and which toolset to enroll under). These
  are tags; the underlying logic stays put.

**If Salesforce decides the right home for Comms-aware MCP tools is
inside the official `@salesforce/mcp` ecosystem**, the work to switch
this server from standalone to `mcp-provider` form is one adapter
file and one new entry point — the tool logic itself does not change.
That option is intentionally kept open.

If, instead, the right outcome is for these tools to remain a separate
companion server (the current shape), nothing changes. Either path
works without rewriting the tools.

---

## 7. Runtime and deployment model

### 7.1 Transport

`stdio`. The server reads MCP-protocol JSON from stdin and writes
responses to stdout. Logs go to stderr. This is the model expected
by every MCP client we are aware of (Claude Desktop, Cursor,
Windsurf).

There is no HTTP listener, no socket, no background daemon. The MCP
client starts the server as a subprocess when needed.

### 7.2 Process and state

- One process per MCP client launch.
- In-memory connection cache (keyed by alias / username) lives for
  the lifetime of the process.
- No on-disk state written by the server itself. Anything persisted
  is persisted by `@salesforce/core` or the CLI (auth tokens in the
  CLI's keychain, not this server's concern).

### 7.3 Security boundary

| Risk | Mitigation |
|------|------------|
| Token leakage in code | No tokens in the repo. Auth is delegated to the CLI. |
| Token leakage in logs | Logs are minimal and never include connection objects. |
| SOQL injection via tool arguments | All IDs validated with `isValidSalesforceId` before interpolation; other arguments are constant text. |
| Accidental writes | All tools are read-only by construction; there is no path through the codebase that issues `INSERT` / `UPDATE` / `DELETE`. |
| Unauthorized org access | Every connection ultimately comes from a session the CLI user already authorized via `sf org login web`. |
| Cross-org data leakage | Connection cache is keyed by alias; tool calls do not silently fall back to a different org. |

---

## 8. Non-functional considerations

### 8.1 Performance

- Detection probes (`namespace_detect`) run in parallel via
  `Promise.all`. The bottleneck is Salesforce describe latency, not
  the client.
- Tools batch SOQL where possible — for example, `M2` resolves
  category relationships and product details in two queries against
  bulk `IN` clauses rather than N round-trips.
- Connection cache avoids re-resolving an alias on the second tool
  call.

Large orgs (thousands of categories, hundreds of catalogs) have not
yet been stress-tested. The `productLimit` parameter on `M2` exists
specifically so callers can bound the work; the default of 200 is
chosen to suit interactive LLM use.

### 8.2 Robustness

- Object existence is re-checked inside a tool when a downstream step
  depends on it (e.g. `M3` graceful-degrades when
  `ProductAttributeDefinition` is missing).
- Foreign keys are filtered for null before being placed in `IN`
  clauses (e.g. `vlocity_cmt__Product2Id__c` skipping promo-only
  relationship rows).
- ObjectClass parent-walk is hop-capped to defend against
  pathological loops.
- JSON BLOB parsing is best-effort: malformed JSON returns an empty
  attribute list rather than throwing.

### 8.3 Observability

- Tool errors return `isError: true` with a human-readable message;
  no half-filled payloads.
- Salesforce API errors propagate verbatim so the user can see
  permission / API-version issues directly.
- Verbose logging is intentionally minimal; the MCP client is the
  primary observer.

### 8.4 Versioning

- `package.json` carries the current alpha version (`0.1.0-alpha.0`
  at the time of writing).
- Git tags mark notable snapshots (`v0.1.0-alpha.0`) so reviewers
  can pin to a specific point in time.
- Backwards-compatibility commitments are deliberately not made at
  this stage; the project is in an early, pre-1.0 state.

---

## 9. Limitations and trade-offs (honest list)

These are known limitations, not bugs:

- **Hybrid orgs surface duplicate `Product2` IDs** across the
  `vlocity_cmt` and `standard` sections. This is intentional — both
  sides have legitimate, different views of the same record — but
  callers consuming results must be aware of it.
- **ObjectClass tree is fetched as a single batch.** For orgs with
  thousands of ObjectClass records the response will be larger than
  may be comfortable for the LLM context window. A future
  improvement is to expose it lazily / on demand.
- **No pricing.** `PriceListEntry__c` / `PriceAdjustmentSchedule`
  walking is intentionally out of Layer 1 scope (see
  [`DESIGN.md`](./DESIGN.md) §8).
- **Connection cache lifetime equals process lifetime.** If the
  Salesforce session expires mid-process, the cached connection
  becomes stale and the next call fails until a new MCP client launch
  re-creates the process.
- **Windows path handling.** Tooling such as `sf` and `npm` ships as
  `.cmd` shims on Windows; the smoke scripts and our build
  documentation handle this, but it is something a reviewer cloning
  the repo on Linux / macOS will not see.
- **No write tools.** This is a deliberate posture, not a missing
  feature. Adding write tools would significantly raise the security
  surface and is left to future work with explicit safeguards.

---

## 10. See also

- [`README.md`](../README.md) — installation, prerequisites,
  per-org-type setup
- [`DESIGN.md`](./DESIGN.md) — per-tool design rationale and SOQL
  strategies
- [`NAMESPACE_TRANSITION.md`](./NAMESPACE_TRANSITION.md) — background
  on the vlocity_cmt → Core landscape this server is built against
- [`LICENSE`](../LICENSE) — proprietary license terms
- [`EXAMPLES.md`](./EXAMPLES.md) — anonymized walkthrough per tool
- [`ROADMAP.md`](../ROADMAP.md) — scope and candidate items
