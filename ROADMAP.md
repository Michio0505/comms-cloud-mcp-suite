# Roadmap

> A short map of what is in this suite today and what is being
> considered next. The scope here is intentionally narrow:
> **read-only inspection** of Communications Cloud assets.

---

## Available today

The tools shipped in this repository:

| Tool | Purpose |
|------|---------|
| `namespace_detect` | Classify the org as `vlocity_cmt`, `standard`, `hybrid`, or `none`. |
| `list_products` | Walk catalogs → categories → products as a JSON tree. Namespace-aware; returns both views on hybrid orgs. |
| `get_product_details` | Full picture for a single `Product2`: ObjectClass lineage, parsed attribute BLOB (Vlocity), or ProductAttributeDefinition resolution (Core). |
| `get_decomposition_map` | Decomposition relationships for a single Vlocity `Product2`: source-side (commercial / parent) and destination-side (technical / child) rows in `vlocity_cmt__DecompositionRelationship__c`. Vlocity-only today; Core equivalent (Dynamic Revenue Orchestrator) is on the candidate list below. |
| `list_orchestration_plans` | Vlocity `OrchestrationPlanDefinition` rows with their nested `OrchestrationItemDefinition` steps. `RecordType.DeveloperName` is preserved verbatim, so step types beyond the documented five (PullEvent, SubPlan, …) survive intact. Vlocity-only today. |

See [`docs/DESIGN.md`](./docs/DESIGN.md) for the per-tool design and
[`docs/EXAMPLES.md`](./docs/EXAMPLES.md) for sample sessions.

---

## Under consideration

The bar for adding a tool is "read-only inspection that benefits from
being namespace-aware". A working list of candidates, loosely ordered
by impact observed during real-org walkthroughs:

- **Data-quality diagnostics** — surface anomalies such as products
  whose ObjectClass is unassigned, products whose `isConfigurable`
  flag contradicts the absence of attributes, or duplicate
  ObjectClass names within the same org.
- **Hybrid-org reconciliation** — for a single `Product2`, present
  the Vlocity-side and Core-side metadata side by side, with the
  delta highlighted.
- **Order Management inspection (Core side)** — the Vlocity side
  is now covered by `get_decomposition_map` and
  `list_orchestration_plans` (see the table above). The remaining
  work is the Core / Dynamic Revenue Orchestrator side
  (`FulfillmentWorkspace` / `FulfillmentRequest`), to give the
  same comparison lens across both models. Migration discussions
  benefit from being able to set the two views side by side.

None of these are committed deliverables. They are candidates that
would each warrant their own design pass before implementation. The
list itself is expected to grow as we walk more orgs and as
reviewer feedback surfaces new gaps.

---

## What is *not* on the roadmap

To set expectations clearly:

- **Write tools.** This suite is read-only by design. Any capability
  that writes back to a Salesforce org raises the safety surface
  considerably and is out of scope here.
- **Runtime pricing evaluation.** Computing a final price requires
  runtime context and is out of scope; see
  [`docs/DESIGN.md`](./docs/DESIGN.md) §8.
- **Order Management runtime walking.** Inspecting
  `OrchestrationPlan__c` instances (not their definitions) is out
  of scope; the runtime picture is still primarily Vlocity-shaped.
- **Bundled or branded Salesforce integration claims.** Anything
  that would imply official Salesforce endorsement is out of
  scope until alignment discussions reach that point.

---

## Versioning posture

- The current tag is **`v0.1.0-alpha.0`**.
- Backwards-compatibility is **not** a commitment at this stage.
- Notable snapshots are tagged so reviewers can pin to a specific
  point in time.

A stable `v1.0.0` would only follow once the Layer of read-only
inspection tools is validated by external reviewers and any
feedback is incorporated.

---

## See also

- [`README.md`](./README.md) — installation, prerequisites, per-org
  setup
- [`LICENSE`](./LICENSE) — licensing terms
- [`docs/DESIGN.md`](./docs/DESIGN.md) — per-tool design
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system
  structure and ecosystem positioning
- [`docs/NAMESPACE_TRANSITION.md`](./docs/NAMESPACE_TRANSITION.md) —
  why the namespace landscape is shaped the way it is
- [`docs/EXAMPLES.md`](./docs/EXAMPLES.md) — anonymized walkthrough
