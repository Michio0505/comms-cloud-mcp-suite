# Namespace Transition: `vlocity_cmt` → Core / Industries

> Status: Working notes — based on hands-on inspection of three orgs (CMT-only, Core-only, hybrid).
> Audience: Salesforce reviewers and Comms Cloud implementation teams.

This document captures what we have observed about how Communications Cloud
assets shift between the legacy `vlocity_cmt` namespace and the newer Core /
Industries namespace, and where the MCP server in this repository fits into
that transition.

It is intentionally **descriptive, not prescriptive**: many of the mappings
below were discovered by walking real orgs with the tools in this repo, and
some still have open questions which we hope to align with Salesforce's
official direction.

---

## 1. The two namespaces in plain terms

| Namespace | Where you see it | Example object | Typical role today |
|-----------|------------------|----------------|--------------------|
| `vlocity_cmt__*` | Industries CMT managed package (legacy) | `vlocity_cmt__Catalog__c` | Existing Comms implementations, in production |
| Core / Industries (no prefix) | Standard NS on the Salesforce platform | `ProductCatalog` | New Comms-on-Core / Revenue Cloud builds |

In practice we see three org topologies:

1. **CMT-only** — pure `vlocity_cmt` install. Standard NS Comms objects
   (`ProductCatalog`, `ProductCategory`, `AttributeDefinition`) are absent.
2. **Core-only** — fresh Comms-on-Core orgs. The `vlocity_cmt` package is
   not installed.
3. **Hybrid** — both present in the same org. The most common state for
   organizations actively transitioning. Often the same `Product2` records
   carry both the legacy `vlocity_cmt__*` fields and the new Core
   relationships (`ProductCategoryProduct`, `ProductSellingModelId`, …).

The MCP server in this repo detects which case it is dealing with via the
`namespace_detect` tool (`vlocity_cmt` / `standard` / `hybrid` / `none`), and
every other tool branches its SOQL accordingly.

---

## 2. Object-level mapping observed so far

### 2.1 Enterprise Product Catalog (EPC)

| Concept | `vlocity_cmt__*` | Core / Industries | Kind of change |
|---------|------------------|---------------------|----------------|
| Catalog | `vlocity_cmt__Catalog__c` | `ProductCatalog` | Rename |
| Catalog code | `vlocity_cmt__CatalogCode__c` | `ProductCatalog.Code` | Field rename |
| Product category / object type | `vlocity_cmt__ObjectClass__c` | `ProductCategory` | Rename; concept preserved |
| Category parent (self-FK) | `vlocity_cmt__ParentObjectClassId__c` | `ProductCategory.ParentCategoryId` | Same shape |
| Category root reference | `vlocity_cmt__RootObjectClassId__c` | (derive by walking up `ParentCategoryId`) | Minor structural change |
| Product | `Product2` (with `vlocity_cmt__*` extensions) | `Product2` (with Core / Industries extensions) | Same sObject, different field sets |
| Product ↔ category link | `Product2.vlocity_cmt__ObjectTypeId__c` (FK on `Product2`) | `ProductCategoryProduct` (junction object) | **Structural change**: 1:N → N:N |
| Catalog ↔ product link | `vlocity_cmt__CatalogProductRelationship__c` (junction, with optional `vlocity_cmt__PromotionId__c`) | `ProductCategoryProduct` (junction with `CatalogId` + `ProductCategoryId` + `ProductId`) | Junction unification |
| Attribute definition | `vlocity_cmt__ObjectTypeField__c` (attached to ObjectClass) | `AttributeDefinition` (standalone) + `ProductAttributeDefinition` (junction to `Product2`) | **Standalone-ization** |
| Attribute picklist | `vlocity_cmt__VlocityPicklist__c` | `AttributePicklist` + `AttributePicklistValue` | Rename + value split |
| Per-product attribute values (BLOB) | `Product2.vlocity_cmt__JSONAttribute__c` (text blob) | No single equivalent — values live across `ProductAttributeDefinition`, `Product2` fields, etc. | **Format change** (JSON blob → structured records) |

**Important nuance — `ObjectClass` vs `ObjectType`**: in older Vlocity CMT
installs, the category-like object is `vlocity_cmt__ObjectClass__c`. Newer
installs add `vlocity_cmt__ObjectType__c`. We have seen both. The MCP
treats `Catalog__c` as the primary signal for "is this Vlocity?" because
it is present in both old and new package versions.

### 2.2 Pricing

| Concept | `vlocity_cmt__*` | Core / Industries | Kind of change |
|---------|------------------|---------------------|----------------|
| Price list | `vlocity_cmt__PriceList__c` | `PriceAdjustmentSchedule` + `PricingRecipe` | **Redesign — no 1:1 mapping** |
| Price entry | `vlocity_cmt__PriceListEntry__c` | `PriceBookEntry` (+ extensions) | Redesign |
| Pricing variable | `vlocity_cmt__PricingVariable__c` | TBD | **Open question** |
| Price book | `Pricebook2` (standard) | `Pricebook2` | Unchanged |

Pricing is the area where we see the biggest conceptual gap. A direct
"export from CMT and import to Core" of pricing assets is not realistic
without a transformation step.

### 2.3 Context rules

| Concept | `vlocity_cmt__*` | Core / Industries | Kind of change |
|---------|------------------|---------------------|----------------|
| Context variable | `vlocity_cmt__ContextDimension__c` | `ContextDefinition` | Rename |
| Context scope (sObject field binding) | `vlocity_cmt__ContextScope__c` | `ContextAttribute` | Rename |
| Context mapping | `vlocity_cmt__ContextMapping__c` | `ContextAttributeMapping` | Rename |
| Rule set | `vlocity_cmt__ContextRuleset__c` | TBD | **Open question** |

### 2.4 Order Management / Orchestration

| Concept | `vlocity_cmt__*` | Core / Industries | Kind of change |
|---------|------------------|---------------------|----------------|
| Orchestration plan definition | `vlocity_cmt__OrchestrationPlanDefinition__c` | (remains in `vlocity_cmt`) | **Not migrated yet** |
| Orchestration item definition | `vlocity_cmt__OrchestrationItemDefinition__c` | (same) | Not migrated yet |
| Dependency definition | `vlocity_cmt__OrchestrationDependencyDefinition__c` | (same) | Not migrated yet |
| Runtime plan | `vlocity_cmt__OrchestrationPlan__c` | (same) | Not migrated yet |
| Decomposition relationship | `vlocity_cmt__DecompositionRelationship__c` | (same) | Not migrated yet |

As of our investigation, **the OM / Orchestration layer is the area where
the migration story is least complete on the Core side**. Even Core-only
orgs we have looked at do not expose a direct replacement for these
objects. This is one of the topics we would most like to align with
Salesforce's roadmap.

### 2.5 Promotions

| Concept | `vlocity_cmt__*` | Core / Industries | Kind of change |
|---------|------------------|---------------------|----------------|
| Promotion definition | `vlocity_cmt__Promotion__c` (presumed) | TBD | Open question |
| Applied promotion (account level) | `vlocity_cmt__AccountAppliedPromotion__c` | TBD | Open question |

---

## 3. Real-world hybrid patterns

The orgs we used to validate the MCP cover the three topologies:

| Org alias (internal label) | Vlocity signals | Core signals | Topology |
|----------------------------|------------------|--------------------|----------|
| `vlocity-cmt-org` | `Catalog__c` (5), `ObjectClass__c` (75), `CatalogProductRelationship__c` (27) | none | Pure `vlocity_cmt` |
| `comms-on-core2025` | none | `ProductCatalog` / `ProductCategory` / `AttributeDefinition` (schema present, data empty) | Pure Core |
| `hybrid-org` | `Catalog__c` (9), `ObjectClass__c` (98) | `ProductCatalog` (1), `ProductCategory` (1), `AttributeDefinition` (7) | Hybrid |

The hybrid case is the most instructive. In that org we observed:

- The same `Product2` records appear in both worlds — they have
  `vlocity_cmt__ObjectTypeId__c` populated **and** appear in
  `ProductCategoryProduct`.
- `vlocity_cmt__JSONAttribute__c` (the legacy per-product BLOB) is
  populated on some products and not on others.
- The Vlocity catalogs (`vlocity_cmt__Catalog__c`) and the standard
  `ProductCatalog` records are independent — neither side reflects the
  other's hierarchy.

→ For tooling that wants to give a unified view, this means resolving
both worlds and reconciling them at the `Product2` level.

---

## 4. Implementation gotchas (things that surprised us)

### 4.1 The `vlocity_cmt__JSONAttribute__c` blob has more than one shape

The per-product attribute BLOB has at least two observed shapes, depending on
Vlocity version and how the data was authored:

- **Shape A** (modern): top-level object keyed by category code,
  e.g. `{ "ACAT_Phones": [ { ... attribute records ... } ] }`.
  Attribute fields use names like `attributeuniquecode__c`,
  `attributedisplayname__c`, `valuedatatype__c`, `value__c`.
- **Shape B** (older): array of category entries, each with a nested
  `productAttributes.records` list. Field names use the PascalCase
  conventions (`Code__c`, `Name__c`, `dataType`).

The MCP parses both. Any migration tool that wants to read product
attributes from CMT data needs to do the same.

### 4.2 An implicit `ATT_DT_` / `ATT_RT_` naming convention

While inspecting attribute codes in standard sample catalogs, we noticed
a consistent prefix convention that does not appear in official
documentation:

| Prefix | Meaning | Read-only? | Value set |
|--------|---------|------------|-----------|
| `ATT_DT_*` | Design-time spec (product identity) | `true` | Filled at catalog authoring time |
| `ATT_RT_*` | Run-time selection (customer choice) | `false` | Filled at cart time |

This is a hint about how the standard Vlocity sample catalogs treat the
distinction between "what is this product" and "what does the customer
choose when buying it". Whether the Core / Industries model formalizes
this distinction, or not, is an open question.

### 4.3 Asymmetry in how products are linked

- **CMT**: `Product2 ── via vlocity_cmt__CatalogProductRelationship__c ──> vlocity_cmt__Catalog__c`
  (many-to-many between products and catalogs)
- **CMT**: `Product2.vlocity_cmt__ObjectTypeId__c ──> vlocity_cmt__ObjectClass__c`
  (1:1 product-to-category, with optional category hierarchy)
- **Core**: `ProductCategoryProduct (Product2 + ProductCategory + ProductCatalog, all three)`

Same intent, different topology. Migration tools have to choose a
canonical representation; ours produces a unified tree but exposes
both views on hybrid orgs so the user can see what is present where.

### 4.4 `ProductCatalog` itself has varying field sets

In one org we tested, `ProductCatalog` had only `Id`, `Name`, and a custom
`External_ID__c`. In another, it had `Code`, `Description`,
`EffectiveStartDate`, `EffectiveEndDate`, `CatalogType`. The MCP queries
only universally available fields (`Id`, `Name`) and degrades gracefully.

---

## 5. Where this MCP fits in a migration journey

A typical CMT → Core migration journey looks something like:

```
1. Discovery / assessment
   ├─ "What is in the legacy CMT org?"
   └─ "What is the shape of each catalog / product / rule?"

2. Mapping design
   ├─ "Which CMT objects map to which Core objects?"
   └─ "Where are the gaps (no direct mapping)?"

3. Transformation
   ├─ Generate Core-native metadata + records
   └─ Handle redesigned areas (Pricing, Promotions)

4. Validation
   └─ "Does the Core org match the intent of the CMT org?"
```

The current MCP (this repo) covers **(1) Discovery / assessment** and
**(4) Validation** end-to-end for the EPC and Vlocity OM layers, with
namespace-aware behavior across all three org topologies. It does
this with read-only tools so it can be run safely against any org
the user has CLI access to, including production-like data.

Mapping design (2) and transformation (3) are intentionally **out of
scope for this suite**.

---

## 6. Open questions we would like to align on

These are the questions we run into most often when reasoning about
migration, and where official guidance would be most useful:

1. **Order Management / Orchestration** — is the long-term plan to keep
   the `vlocity_cmt` OM model, or is a Core-native replacement on the
   roadmap?

2. **Pricing** — is there a canonical mapping reference from
   `vlocity_cmt__PriceList__c` / `PriceListEntry__c` to
   `PriceAdjustmentSchedule` / `PricingRecipe`? Discounts, time plans,
   and pricing variables are the gaps we feel most.

3. **Promotions** — is there an official migration target for
   `vlocity_cmt__Promotion__c` family?

4. **Context rules** — `ContextRuleset__c` does not have a confirmed
   Core counterpart in what we have seen. Has this been retired,
   renamed, or simply not migrated yet?

5. **Recommended sequence** — for a customer doing a full migration in
   2026–2027, what sequence does Salesforce recommend? EPC first
   (with OM remaining on CMT), Pricing first, all at once?

6. **Tool boundary** — where would Salesforce prefer an external,
   partner-built MCP to focus, and which areas should partners assume
   will be served by official tooling?

---

## 7. References (internal repo only)

- [`README.md`](../README.md) — server overview and tool list
- `src/tools/m1-namespace-detect.ts` — the topology detection logic
  referenced in §1
- `src/tools/m2-list-products.ts` — implements §2.1 catalog walking for
  both namespaces
- `src/tools/m3-get-product-details.ts` — implements §4.1 BLOB shape A/B
  parsing and the `ATT_DT_` / `ATT_RT_` observation from §4.2

External references (Salesforce official) will be added here as
alignment progresses.

---

*This document is maintained as working notes. We welcome corrections,
additions, and clarifications — particularly from anyone closer to the
official Salesforce roadmap than we are. See the project
[LICENSE](../LICENSE) for terms.*
