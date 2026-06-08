# @kccs/comms-cloud-mcp-suite

> Status: 🚧 Pre-release — MVP under active development. APIs may change.
> Distribution: by invitation only. License terms apply (see [License](#license)).

A Model Context Protocol (MCP) server that lets AI clients (Claude Desktop, Cursor,
Windsurf, etc.) explore Salesforce **Communications Cloud** catalogs and orchestration
artifacts directly — across **Vlocity CMT** (`vlocity_cmt__`) and **standard NS**
(Revenue Cloud / Comms-on-Core) orgs, including **hybrid orgs** where both coexist.

---

## What it does

Communications Cloud implementations on Salesforce typically involve a large product
catalog and a complex order/orchestration layer. Inspecting that data with the
Salesforce CLI alone is slow and error-prone, especially when you don't yet know
whether you're looking at a Vlocity CMT org, a Core / Revenue Cloud org, or a hybrid.

This MCP server gives an AI assistant a small set of **read-only** tools that:

- Detect which Comms Cloud variant a given org uses
- Walk the product catalog hierarchy
- Pull the full attribute / price / classification picture for a single product

The intent is to let the AI assistant answer questions like
*"What products live under the 'Mobile Plans' category in this catalog, and which
attributes do they share?"* without the user writing SOQL by hand.

## Tools (MVP scope)

| # | Tool name | Status | Summary |
|---|-----------|--------|---------|
| M1 | `namespace_detect` | ✅ available | Identify the org's Comms Cloud variant: `vlocity_cmt` / `standard` / `hybrid` / `none`. |
| M2 | `list_products` | ✅ available | Walk catalogs → categories → products as a JSON tree. Namespace-aware; returns both views on hybrid orgs. |
| M3 | `get_product_details` | ✅ available | Full product info for one `Product2`: ObjectClass lineage, parsed attribute BLOB (Vlocity), and ProductAttributeDefinition resolution (Core). |
| M4 | `get_decomposition_map` | ✅ available (Vlocity) | Decomposition relationships for one `Product2`: rows where it appears as source (commercial / parent) and destination (technical / child). |
| M5 | `list_orchestration_plans` | ✅ available (Vlocity) | Vlocity OM plan definitions with nested step definitions (`RecordType.DeveloperName` preserved verbatim, including PullEvent / SubPlan / future types). |

This suite focuses on **read-only inspection**. Any write or generation
capability is intentionally out of scope. See [`ROADMAP.md`](./ROADMAP.md)
for what is being considered next, and [`LICENSE`](./LICENSE) for the
licensing terms.

---

## Requirements

- **Node.js** ≥ 20
- **Salesforce CLI** (`sf`) version 2.x or later, on `PATH`
- At least one Salesforce org **already authenticated** via `sf org login web`
- The authenticated user must have **read access** to the Comms Cloud objects in
  scope (see [Environment preparation](#environment-preparation-by-org-type) below)

The server uses `@salesforce/core` to resolve connections from an alias or username
that the Salesforce CLI already knows about — it does **not** ask you for credentials.

---

## Supported environments

| Variant | Detected as | Primary signal |
|---------|-------------|----------------|
| Vlocity CMT (Industries CMT package installed) | `vlocity_cmt` | `vlocity_cmt__Catalog__c` exists |
| Standard NS (Revenue Cloud / Comms-on-Core) | `standard` | `ProductCatalog`, `ProductCategory`, `AttributeDefinition` all exist |
| Hybrid (both present in the same org) | `hybrid` | Both signals above |
| No Comms Cloud signature | `none` | Neither signal |

Always start by running `namespace_detect` against your target org — every other
tool's behavior branches on that result, and the same prompt may need a different
query strategy for `vlocity_cmt` vs `standard`.

---

## Environment preparation by org type

### Vlocity CMT orgs

- **Package**: the Vlocity Industries CMT managed package must be installed.
  Confirm with `sf data query --query "SELECT NamespacePrefix FROM ApexClass WHERE NamespacePrefix = 'vlocity_cmt' LIMIT 1"`.
- **Object access (read)** required on at least:
  - `vlocity_cmt__Catalog__c`
  - `vlocity_cmt__ObjectClass__c` (older Vlocity) and/or `vlocity_cmt__ObjectType__c` (newer)
  - `Product2`
  - `vlocity_cmt__Attribute__c`, `vlocity_cmt__AttributeAssignment__c`
  - `vlocity_cmt__PriceList__c`, `vlocity_cmt__PriceListEntry__c`
- **API version**: 50.0 or later recommended.
- **Note on Vlocity versions**: older orgs ship `ObjectClass__c` only; newer orgs ship
  `ObjectType__c` in addition. This MCP handles both.

### Standard NS orgs (Revenue Cloud / Comms-on-Core)

- **Licenses / features**: Revenue Cloud (PCM) must be enabled. Communications-on-Core
  template orgs already meet this.
- **Permission set**: a permission set granting access to PCM objects. The standard
  *"Industry Sales Excellence"* permission set is sufficient for read-only use.
- **Object access (read)** required on at least:
  - `ProductCatalog`, `ProductCategory`, `ProductCategoryProduct`
  - `Product2`, `ProductClassification`, `ProductRelationshipType`
  - `AttributeDefinition`, `AttributeCategory`, `ProductAttributeDefinition`
  - `AttributePicklist`, `AttributePicklistValue`
- **API version**: 60.0 or later recommended.

### Hybrid orgs

- Satisfy both of the preparations above. The MCP will detect both signatures and
  let downstream tools query either side. You can also restrict a single invocation
  to one side using the tool's `mode` parameter (Vlocity-only or standard-only).

### No-Comms orgs

If `namespace_detect` returns `none`, the tools won't have anything meaningful to
list. This usually means either the wrong org is targeted, or the user running the
MCP lacks read access. Re-check the alias and the permission set, then re-run.

---

## Installation

This package is currently distributed privately. Once you have access to the source
tree:

```bash
npm install
npm run build
```

For development without an explicit build step:

```bash
npm run dev
```

---

## MCP client configuration

Add the server to your MCP client. Examples below assume a local checkout; once we
publish to a private registry the `command` line will become `npx @kccs/comms-cloud-mcp-suite`.

### Claude Desktop / Cursor / Windsurf

```json
{
  "mcpServers": {
    "comms-cloud-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/comms-cloud-mcp/dist/server.js"]
    }
  }
}
```

The server speaks MCP over stdio. No environment variables are required; org
authentication is read from the Salesforce CLI's local store.

---

## Quick start

```text
You: Which Communications Cloud variant is the org 'sandbox-uat-01' running?

AI (via namespace_detect):
{
  "namespace": "vlocity_cmt",
  "details": {
    "orgUsername": "...",
    "instanceUrl": "https://...my.salesforce.com",
    "apiVersion": "66.0",
    "vlocity": { "vlocity_cmt__Catalog__c": true, ... },
    "standard": { "ProductCatalog": false, ... }
  }
}
```

A typical session continues with `list_products` to walk the catalog, then
`get_product_details` for a specific SKU once an interesting candidate is found.
See [`docs/EXAMPLES.md`](./docs/EXAMPLES.md) for anonymized walkthroughs of all
three tools across three reference orgs (Vlocity-only, Core-only, hybrid),
including the LLM-driven analyses they enable.

---

## Documents

| File | Reads as |
|------|----------|
| [`README.md`](./README.md) | This file — installation, prerequisites, MCP client wiring. |
| [`ROADMAP.md`](./ROADMAP.md) | Layer 1 scope and candidate items under consideration. |
| [`LICENSE`](./LICENSE) | Proprietary license — invited evaluation only, see file for full terms. |
| [`docs/DESIGN.md`](./docs/DESIGN.md) | Per-tool design notes: scope, SOQL strategy, returned shape, edge cases. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | System layering, dependency choices, and how this server is meant to fit alongside `@salesforce/mcp` and `@salesforce/omnistudio-mcp`. |
| [`docs/EXAMPLES.md`](./docs/EXAMPLES.md) | Anonymized walkthrough of the three tools against three reference orgs, plus the LLM analyses they enabled. |
| [`docs/NAMESPACE_TRANSITION.md`](./docs/NAMESPACE_TRANSITION.md) | Background on the `vlocity_cmt` → Core / Industries landscape, observed object mappings, and open questions for Salesforce. |

If you are reading the repository for the first time, the recommended order is:
**README → ROADMAP → docs/NAMESPACE_TRANSITION → docs/ARCHITECTURE → docs/DESIGN
→ docs/EXAMPLES**.

---

## Smoke test (developers only)

Non-MCP scripts let you exercise the tools directly against a CLI-authenticated
org. Useful for verifying access before wiring up an MCP client.

```bash
# Build first
npm install
npm run build

# M1 — detect namespace across one or more orgs
npm run test:m1 -- <org-alias-1> [<org-alias-2> ...]

# M2 — list products in a catalog (verbose against large orgs)
npm run test:m2 -- <org-alias>

# M3 — get full details for one or more products
npm run test:m3 -- <org-alias>:<product-id> [<org-alias>:<product-id> ...]

# M4 — get decomposition map for a Vlocity product
npm run test:m4 -- <org-alias>:<product-id> [<org-alias>:<product-id> ...]

# M5 — list Vlocity orchestration plans (verbose against large orgs)
npm run test:m5 -- <org-alias> [<org-alias> ...]
```

These scripts authenticate the same way the MCP server does — via the
Salesforce CLI's existing org auth. No additional credentials are needed.

For richer sample output and prompt-driven sessions, see
[`docs/EXAMPLES.md`](./docs/EXAMPLES.md).

---

## Troubleshooting

- **`Object not found` / `INVALID_TYPE`** — the authenticated user can't see the
  target sObject. Verify that the right managed package is installed *and* that
  the user has read access via permission sets or profiles.
- **`No authorization found for ...`** — the alias isn't known to the Salesforce
  CLI. Run `sf org list` to confirm, or re-authenticate with `sf org login web --alias <alias>`.
- **`ObjectType__c is not supported`** but `ObjectClass__c` works — this is normal
  on older Vlocity CMT orgs. `namespace_detect` already accounts for it.
- **Slow first call** — `@salesforce/core` caches token info after the first
  invocation per process. Subsequent calls reuse the connection.

---

## Status and roadmap

This MVP intentionally ships only the read-only inspection tools
(M1 → M5). Anything that writes back to a Salesforce org is out of
scope for the suite as it stands today.

For the candidate items being considered next, see
[`ROADMAP.md`](./ROADMAP.md). Licensing terms are in
[`LICENSE`](./LICENSE).

For inquiries, contact the maintainer (see [`LICENSE`](./LICENSE) for the
contact address).

---

## License

This software is licensed under a proprietary license.
See [LICENSE](./LICENSE) for full terms.

In short: invited recipients may evaluate and provide feedback,
but commercial use, redistribution, and modified version
distribution require prior written consent from the copyright
holder.

For commercial licensing inquiries, contact michio-sekido@kccs.co.jp.
