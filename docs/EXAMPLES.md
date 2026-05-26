# Examples — Comms Cloud MCP in Action

> This document shows the three tools in this repository **being used**,
> against three reference orgs that cover the main topologies in the
> wild. Read [`README.md`](../README.md) first for installation and
> [`DESIGN.md`](./DESIGN.md) for the per-tool rationale.
>
> Names of catalogs and products in this document are **anonymized**.
> Real customer / project names do not appear here; the structural
> patterns are real and were observed against actual orgs we have
> access to.

What these examples are really about:

- The MCP tools are read-only, namespace-aware, and small. They do
  not pretend to "understand" Communications Cloud. The interesting
  capability emerges when those small tools are placed in front of
  an LLM (Claude in our tests) that *does* know the domain.
- The same set of tools therefore acts as a **catalog-quality
  diagnostic** on day one of looking at an org, without any
  Comms-specific configuration.
- That is the value proposition we want to make visible here.

---

## Reference orgs

We use three reference orgs, deliberately covering all three
topologies described in
[`NAMESPACE_TRANSITION.md`](./NAMESPACE_TRANSITION.md) §1.

| Label in this document | Topology | Real-world feel |
|------------------------|----------|-----------------|
| `cmt-sample-org` | Pure `vlocity_cmt` | A classic Vlocity CMT install with sample catalogs. The kind of org an SI inherits from a legacy implementation. |
| `core-dev-org` | Pure Core / Industries (standard NS) | A clean Comms-on-Core developer org. PCM schema is present, data is mostly empty. |
| `hybrid-customer-org` | Hybrid | Both packages active. Real product data on the Vlocity side, a small Core-side catalog as well. The most common state for an organization in transition. |

The CLI alias names in actual use differ; in the rest of this
document we use the labels above to keep the text portable.

---

## Level 1 — "What kind of Comms Cloud org am I looking at?"

The first question any honest tooling has to answer. The wrong
strategy applied to the wrong namespace burns time and produces
silently incorrect results.

### Tool: `namespace_detect`

**Prompt to the LLM**:

```
Detect the Comms Cloud namespace of `cmt-sample-org`, `core-dev-org`,
and `hybrid-customer-org`.
```

**Behind the scenes**: the LLM calls `namespace_detect` once per
org. Each call returns the verdict *and* the raw probe results.

**Result for `cmt-sample-org`** (truncated):

```json
{
  "namespace": "vlocity_cmt",
  "details": {
    "orgUsername": "...",
    "instanceUrl": "https://....my.salesforce.com",
    "apiVersion": "66.0",
    "vlocity": {
      "vlocity_cmt__Catalog__c": true,
      "vlocity_cmt__ObjectClass__c": true,
      "vlocity_cmt__ObjectType__c": false
    },
    "standard": {
      "ProductCatalog": false,
      "ProductCategory": false,
      "AttributeDefinition": false
    }
  }
}
```

**Result for `core-dev-org`**:

```json
{
  "namespace": "standard",
  "details": {
    "vlocity": { "vlocity_cmt__Catalog__c": false, ... },
    "standard": {
      "ProductCatalog": true,
      "ProductCategory": true,
      "AttributeDefinition": true
    }
  }
}
```

**Result for `hybrid-customer-org`**:

```json
{
  "namespace": "hybrid",
  "details": {
    "vlocity": {
      "vlocity_cmt__Catalog__c": true,
      "vlocity_cmt__ObjectClass__c": true,
      "vlocity_cmt__ObjectType__c": false
    },
    "standard": {
      "ProductCatalog": true,
      "ProductCategory": true,
      "AttributeDefinition": true
    }
  }
}
```

### Why returning the raw probes matters

The classification could be a one-word answer. We deliberately
return the per-object probe results too. That way an LLM (or a
human) confronted with an unexpected verdict can immediately see
*which* probe pointed where. A common case: an org "should" be
Core but `AttributeDefinition` is missing because of a permission
set, not a missing feature. The probe view surfaces that in one
read.

---

## Level 2 — "Walk the catalog"

Once the topology is known, walk the catalog to see what is
actually in there. This is also where the LLM starts to add value
beyond what the tool itself does.

### Tool: `list_products`

**Prompt to the LLM**:

```
Show me the product catalogs in `cmt-sample-org`, with a small
product limit so we can see structure without drowning in data.
```

**Behind the scenes**: the LLM calls `list_products` with
`productLimit: 10`. The result has two top-level sections for
this Vlocity org: `catalogs` (each with its own products via
`CatalogProductRelationship__c`) and `objectClasses` (the
hierarchy tree, independent of the catalog dimension).

**Excerpt of the returned shape** (heavily truncated):

```jsonc
{
  "detectedNamespace": "vlocity_cmt",
  "vlocity_cmt": {
    "catalogs": [
      {
        "id": "a0c...",
        "name": "Accessories Catalog",
        "code": "Accessories",
        "products": [
          { "id": "...", "name": "Accessory Pack A",
            "productCode": "AC-PA-01", "isActive": true,
            "objectClassId": "a1y...Accessory" },
          ...
        ]
      },
      {
        "id": "a0c...",
        "name": "Mobile Catalog A",
        "code": "MOBILE-CATALOG-A",
        "products": [
          { "id": "...", "name": "Plan A",
            "productCode": "PLAN-A", "isActive": true,
            "objectClassId": null },
          { "id": "...", "name": "Plan B",
            "productCode": "PLAN-B", "isActive": true,
            "objectClassId": null },
          ...
        ]
      },
      ...
    ],
    "objectClasses": [
      {
        "id": "a1y...Base", "name": "Base Product",
        "children": [
          { "id": "...", "name": "Mobile Device",
            "children": [
              { "id": "...", "name": "Handset", "children": [] },
              { "id": "...", "name": "Tablet", "children": [] }
            ]
          },
          ...
        ]
      },
      ...
    ]
  }
}
```

### LLM analysis it produced from that data

This is where the value compounds. From a single `list_products`
call, an LLM familiar with Comms Cloud surfaced four observations
**without any extra prompting**:

> 1. **`Mobile Catalog A` has products with `objectClassId: null`.**
>    These products are not attached to any ObjectClass and
>    therefore cannot inherit attributes — `Plan A`, `Plan B`, and
>    six siblings all share this problem. In a Configurable-Offer
>    flow this is a silent break.
>
> 2. **Duplicate ObjectClass names found.** Two records both
>    named `Protection Plan` (with different IDs), three records
>    named `Discount`. This is the classic DataPack-import
>    duplication footprint.
>
> 3. **Catalog and ObjectClass are independent dimensions in
>    this Vlocity install.** The same product can appear in
>    multiple catalogs via `CatalogProductRelationship__c` and
>    is separately placed in the ObjectClass tree via
>    `Product2.vlocity_cmt__ObjectTypeId__c`. The Core PCM model
>    collapses these into a single hierarchy.
>
> 4. **One catalog has zero products** — likely a template that
>    was created and never populated, or a placeholder for a
>    promotion-driven offer set.

We did not write any of those bullet points by hand for this
document. They came out of the LLM session that called
`list_products`. They are the kind of observations a Comms
implementation consultant would make on a first walkthrough — and
the MCP enabled the LLM to make them from scratch, on day one,
against a real org.

---

## Level 3 — "Get the full picture for one product"

`list_products` surfaces candidates. `get_product_details` is the
deep dive on one record.

### 3.1 A healthy reference: `Product X`

`Product X` lives in the same `cmt-sample-org` as the products
above. It is a Handset-class product that we use as the healthy
reference: it has an `ObjectClass`, a populated attribute BLOB,
and a documented `specificationType`.

**Prompt to the LLM**:

```
Show me the details of Product X (Salesforce ID 01t...).
```

**Excerpted result**:

```jsonc
{
  "vlocity_cmt": {
    "name": "Product X",
    "productCode": "PRODUCT-X-01",
    "description": "...",
    "family": "Handset",
    "isActive": true,
    "specificationType": "Product",
    "subType": "None",
    "status": "Active",
    "isOrderable": false,
    "isConfigurable": true,
    "objectClass": {
      "id": "a1y...",
      "name": "Handset",
      "path": [
        { "id": "a1y...", "name": "Base Product" },
        { "id": "a1y...", "name": "Mobile Device" },
        { "id": "a1y...", "name": "Handset" }
      ]
    },
    "attributeCategories": [
      {
        "code": "ACAT_Phones",
        "name": "Mobile Devices",
        "attributes": [
          { "code": "ATT_DT_BRD", "name": "Brand",
            "dataType": "Picklist", "value": "<vendor>",
            "isRequired": false },
          { "code": "ATT_DT_SZ", "name": "Size",
            "dataType": "Text", "value": "5.65 x 2.79 x 0.30",
            "isRequired": false },
          { "code": "ATT_DT_CAP", "name": "Capacity",
            "dataType": "Picklist", "value": "64 GB",
            "isRequired": false },
          { "code": "ATT_RT_PAY_TYPE", "name": "Payment Type",
            "dataType": "Picklist", "value": null,
            "isRequired": false },
          { "code": "ATT_RT_CLR", "name": "Color",
            "dataType": "Picklist", "value": null,
            "isRequired": true },
          { "code": "ATT_RT_MOS", "name": "Mobile OS",
            "dataType": "Picklist", "value": "Android",
            "isRequired": false }
        ]
      }
    ],
    "attributeMetadataPresent": true,
    "jsonAttributePresent": true
  }
}
```

### 3.2 A broken counterpart: `Plan A`

`Plan A` is one of the `objectClassId: null` products that
Level 2 already flagged.

**Prompt to the LLM**:

```
Show me the details of Plan A (Salesforce ID 01t...).
```

**Excerpted result**:

```jsonc
{
  "vlocity_cmt": {
    "name": "Plan A",
    "productCode": "PLAN-A",
    "description": "Plan A (35GB). Includes add-on bundle 1, add-on bundle 2, unlimited boost. First month free.",
    "family": null,
    "isActive": true,
    "specificationType": "Offer",
    "subType": "None",
    "status": "Active",
    "isOrderable": true,
    "isConfigurable": true,
    "objectClass": { "id": null, "name": null, "path": [] },
    "attributeCategories": [],
    "attributeMetadataPresent": false,
    "jsonAttributePresent": false
  }
}
```

Two fields stand out for anyone familiar with the EPC model:

- `isConfigurable: true` is set, claiming the product accepts
  customer-chosen options during ordering.
- `attributeCategories: []` is empty. There is nothing for the
  customer to configure.

These two facts contradict each other.

### 3.3 LLM-driven comparative analysis

We then asked the LLM to compare the two products.

**Prompt**:

```
Compare Plan A and Product X. Focus on what is structurally
different, not just the data.
```

**LLM-produced analysis** (lightly edited for portability):

> **Specification Type signals different intent.**
> `Product X` is a `Product`-type spec — an SKU-level building
> block that is usually wrapped by an Offer at sale time
> (`isOrderable: false` confirms that). `Plan A` is an
> `Offer`-type spec — the unit a customer actually buys
> (`isOrderable: true`). They sit at different layers of the EPC
> model.
>
> **`Product X` has the design density of a real EPC entry.**
> A three-level ObjectClass path (`Base Product → Mobile Device
> → Handset`), six attributes in a single `Mobile Devices`
> category, four of them as design-time spec (`ATT_DT_*`,
> read-only, filled at authoring time) and two as run-time
> selections (`ATT_RT_*`, filled by the customer in the cart).
> One `ATT_RT_*` attribute is marked required.
>
> **`Plan A` is structurally empty.**
> No `ObjectClass`, no attribute categories, no JSON attribute
> blob. Yet it is declared `isConfigurable: true` and is
> `isOrderable: true`. In a cart this would either render with
> nothing to configure or, depending on the front-end, fail to
> render at all.
>
> **The information that should be attribute-shaped is in
> `description` instead.** The Description field of `Plan A`
> says "35GB", "add-on bundle 1", "first month free". Those are
> values that, in a healthy EPC, would each be an
> `AttributeDefinition` so they could drive search, filter, and
> pricing logic. Currently they live as free text that no
> downstream Salesforce mechanism can reach.

That paragraph is not in any of our documentation. It came from
the LLM the moment it had both `get_product_details` results in
its context.

This is the value proposition: the MCP makes the data
**legible** to an LLM that already understands the domain. The
analysis is the LLM's; the MCP's job is to put the right data in
front of it.

---

## The implicit `ATT_DT_` / `ATT_RT_` naming convention

A side-finding worth calling out separately.

While reviewing the raw `vlocity_cmt__JSONAttribute__c` content
on `Product X`, the LLM spotted that attribute codes follow a
two-letter prefix pattern:

> | Prefix | Meaning observed | Read-only? | Filled when? |
> |--------|------------------|------------|--------------|
> | `ATT_DT_*` | Design-time spec — product identity | `true` | Authored at catalog setup |
> | `ATT_RT_*` | Run-time selection — customer choice | `false` | Filled at cart time |
>
> Brand, Size, Capacity, Mobile OS are all `ATT_DT_*` and
> read-only. Payment Type and Color are `ATT_RT_*` and not
> read-only. Color is the one required `ATT_RT_*` attribute.
> The naming convention is *consistent* in standard Vlocity
> sample catalogs but is not documented in the official Vlocity
> docs that we are aware of.

This is a small thing, but it captures the kind of detail that
matters in a real Comms Cloud build:

- It distinguishes "what kind of thing this product is" (DT)
  from "what the customer chooses when buying it" (RT).
- If `Plan A`'s description fields were rebuilt as attributes,
  most of them would be `ATT_DT_*` (data volume, included
  add-ons) and one would be `ATT_RT_*` (contract length).

The MCP itself **does not** automatically classify attributes
by this prefix — see [`DESIGN.md`](./DESIGN.md) §5.4 for why we
chose not to encode an unofficial convention into the tool's
behavior. The codes are returned verbatim; callers who care can
group them.

---

## Hybrid org — both views at once

A hybrid org is where the topology question gets interesting.
The same `Product2` record can exist in both the Vlocity side
and the Core side simultaneously, with different metadata
attached to each.

### Tool: `list_products` on the hybrid org

**Prompt**:

```
Walk the product catalog of `hybrid-customer-org`. I want to see
both the Vlocity side and the Core side.
```

**Excerpted result**:

```jsonc
{
  "detectedNamespace": "hybrid",
  "requestedMode": "auto",
  "queried": ["vlocity_cmt", "standard"],
  "vlocity_cmt": {
    "catalogs": [
      { "id": "a16...", "name": "Add On",
        "code": "AddOn", "products": [...] },
      { "id": "a16...", "name": "Handsets",
        "code": "HANDSETS",
        "products": [
          { "id": "01t...", "name": "<vendor> Phone X",
            "productCode": "VPL_PHONE_X",
            "isActive": true,
            "objectClassId": "a2v...Handset" },
          ...
        ] }
    ]
  },
  "standard": {
    "catalogs": [
      { "id": "0ZS...", "name": "Fixed Service Catalog",
        "categories": [
          { "id": "0ZG...", "name": "Fiber Broadband",
            "parentCategoryId": null,
            "children": [],
            "products": [
              { "id": "01t...", "name": "Fiber Broadband Tier 1",
                "productCode": "CCC_FB_T1", "isActive": true },
              ...
            ] }
        ] }
    ]
  }
}
```

### What this shows

- The Vlocity side has a populated handset catalog with concrete
  products.
- The Core side has a separate `Fixed Service Catalog` with one
  category and four broadband tier products.
- Both are real. Both belong to the same org. They serve
  different parts of the business (mobile devices in the legacy
  CMT model, fixed broadband in the new Core model). Migration
  here is not a single switch — it is a per-line-of-business
  decision.

### Why returning both sides matters

A tool that defaulted to one side and ignored the other would
either tell you "no products" (Core-only mode against the mobile
catalog) or "no fiber" (CMT-only mode against the broadband
catalog). Returning both is the only honest answer for a hybrid
org. The LLM consumes both and can reason about migration
options per line of business.

---

## Reproducing these examples yourself

The interactive examples above assume you have an MCP-capable
client (Claude Desktop, Cursor, …) configured per
[`README.md`](../README.md). If you want to exercise the tools
without the MCP transport — for example to verify connectivity
before wiring up a client — there are smoke-test scripts:

```bash
# Build
cd packages/comms-cloud-mcp
npm install
npm run build

# Smoke test M1 against one or more orgs
npm run test:m1 -- <your-org-alias-1> <your-org-alias-2>

# Smoke test M2 (will be verbose for orgs with many products)
npm run test:m2 -- <your-org-alias>

# Smoke test M3 against specific products
npm run test:m3 -- <your-org-alias>:01t...
```

The scripts print JSON to stdout and exit on completion. They
authenticate the same way the MCP server does (via the
Salesforce CLI's existing org auth).

---

## What we did *not* show in this document

- Pricing walkthroughs. The tools do not walk
  `PriceListEntry__c` / `PriceBookEntry`. See
  [`DESIGN.md`](./DESIGN.md) §8.
- Order Management runtime. The tools do not inspect
  `OrchestrationPlan__c` instances; see
  [`NAMESPACE_TRANSITION.md`](./NAMESPACE_TRANSITION.md) §2.4
  for the broader OM picture.
- Generation or any write-back to a Salesforce org. This suite
  is read-only by design — see [`ROADMAP.md`](../ROADMAP.md)
  and [`LICENSE`](../LICENSE).
- Production data from real customers. All product / catalog /
  plan names in this document are anonymized. The structural
  patterns are real; the labels are not.

---

## See also

- [`README.md`](../README.md) — installation and MCP client wiring
- [`DESIGN.md`](./DESIGN.md) — per-tool design notes
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system-level structure
  and ecosystem positioning
- [`NAMESPACE_TRANSITION.md`](./NAMESPACE_TRANSITION.md) —
  background on the vlocity_cmt → Core landscape
