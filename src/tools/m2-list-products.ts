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
    .enum(["auto", "vlocity_cmt", "standard"])
    .optional()
    .describe(
      "Which Comms Cloud model to query. " +
        "'auto' (default): use whichever variant is detected; if both are present (hybrid), query both. " +
        "'vlocity_cmt': force Vlocity CMT queries (fails if not present). " +
        "'standard': force standard NS queries (fails if not present)."
    ),
  catalogId: z
    .string()
    .optional()
    .describe(
      "Optional Salesforce ID of a single catalog to scope the result. " +
        "If omitted, all catalogs in the selected namespace(s) are returned."
    ),
  includeInactive: z
    .boolean()
    .optional()
    .describe(
      "If true, inactive products and catalogs are included. Defaults to false."
    ),
  productLimit: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe(
      "Maximum total products returned per catalog. Defaults to 200. " +
        "Use a smaller value for fast inspection of large catalogs."
    ),
});

type Input = z.infer<typeof inputSchema>;

type ProductSummary = {
  id: string;
  name: string;
  productCode: string | null;
  isActive: boolean;
  /** Vlocity only: link to vlocity_cmt__ObjectClass__c (a.k.a. ObjectType in older docs). */
  objectClassId?: string | null;
};

type StandardCategoryNode = {
  id: string;
  name: string;
  parentCategoryId: string | null;
  children: StandardCategoryNode[];
  products: ProductSummary[];
};

type StandardCatalog = {
  id: string;
  name: string;
  categories: StandardCategoryNode[];
};

type VlocityObjectClassNode = {
  id: string;
  name: string;
  parentObjectClassId: string | null;
  children: VlocityObjectClassNode[];
};

type VlocityCatalog = {
  id: string;
  name: string;
  code: string | null;
  products: ProductSummary[];
};

export class ListProductsTool extends BaseTool {
  getName(): string {
    return "list_products";
  }

  getConfig() {
    return {
      description:
        "Lists Communications Cloud catalogs, categories, and products as a JSON tree. " +
        "Works against Vlocity CMT orgs (returns vlocity_cmt__Catalog__c with their products " +
        "via vlocity_cmt__CatalogProductRelationship__c, plus a separate vlocity_cmt__ObjectClass__c hierarchy), " +
        "and against standard NS orgs (returns ProductCatalog with nested ProductCategory tree, " +
        "and Product2 records resolved via ProductCategoryProduct). " +
        "On hybrid orgs with mode='auto', both views are returned. " +
        "Use namespace_detect first if you are unsure which model an org uses.",
      inputSchema,
    };
  }

  async exec(args: Record<string, unknown>): Promise<CallResult> {
    try {
      const parsed: Input = inputSchema.parse(args);

      // Validate catalogId shape early (we interpolate it into SOQL).
      if (parsed.catalogId && !isValidSalesforceId(parsed.catalogId)) {
        return errorResult(
          `Invalid catalogId '${parsed.catalogId}'. Expected a 15- or 18-character Salesforce ID.`
        );
      }

      const conn = await this.ctx.sfClient.getConnection(parsed.targetOrg);
      const includeInactive = parsed.includeInactive ?? false;
      const productLimit = parsed.productLimit ?? 200;
      const requestedMode = parsed.mode ?? "auto";

      const availability = await detectAvailableNamespaces(conn);
      const detectedNamespace =
        availability.vlocity && availability.standard
          ? "hybrid"
          : availability.vlocity
            ? "vlocity_cmt"
            : availability.standard
              ? "standard"
              : "none";

      if (detectedNamespace === "none") {
        return errorResult(
          "No Comms Cloud namespace detected in this org. " +
            "Run 'namespace_detect' to see which probe objects are missing."
        );
      }

      if (requestedMode === "vlocity_cmt" && !availability.vlocity) {
        return errorResult(
          "Mode 'vlocity_cmt' was requested, but vlocity_cmt__Catalog__c is not available in this org."
        );
      }
      if (requestedMode === "standard" && !availability.standard) {
        return errorResult(
          "Mode 'standard' was requested, but the standard NS PCM objects are not available in this org."
        );
      }

      const queryVlocity =
        requestedMode === "vlocity_cmt" ||
        (requestedMode === "auto" && availability.vlocity);
      const queryStandard =
        requestedMode === "standard" ||
        (requestedMode === "auto" && availability.standard);

      const result: Record<string, unknown> = {
        detectedNamespace,
        requestedMode,
        queried: [
          ...(queryVlocity ? ["vlocity_cmt"] : []),
          ...(queryStandard ? ["standard"] : []),
        ],
        details: {
          orgUsername: conn.getUsername(),
          instanceUrl: conn.instanceUrl,
          apiVersion: conn.getApiVersion(),
        },
      };

      if (queryVlocity) {
        result.vlocity_cmt = await queryVlocityModel(
          conn,
          parsed.catalogId,
          includeInactive,
          productLimit
        );
      }
      if (queryStandard) {
        result.standard = await queryStandardModel(
          conn,
          parsed.catalogId,
          includeInactive,
          productLimit
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Error listing products: ${msg}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function errorResult(message: string): CallResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function detectAvailableNamespaces(
  conn: Connection
): Promise<{ vlocity: boolean; standard: boolean }> {
  const [vlocityCatalog, productCatalog, productCategory, attributeDef] =
    await Promise.all([
      sObjectExists(conn, "vlocity_cmt__Catalog__c"),
      sObjectExists(conn, "ProductCatalog"),
      sObjectExists(conn, "ProductCategory"),
      sObjectExists(conn, "AttributeDefinition"),
    ]);
  return {
    vlocity: vlocityCatalog,
    standard: productCatalog && productCategory && attributeDef,
  };
}

// -----------------------------------------------------------------------------
// Vlocity CMT strategy
// -----------------------------------------------------------------------------

async function queryVlocityModel(
  conn: Connection,
  catalogId: string | undefined,
  includeInactive: boolean,
  productLimit: number
): Promise<{ catalogs: VlocityCatalog[]; objectClasses: VlocityObjectClassNode[] }> {
  // 1. Catalogs
  let catalogQuery =
    "SELECT Id, Name, vlocity_cmt__CatalogCode__c FROM vlocity_cmt__Catalog__c";
  if (catalogId) catalogQuery += ` WHERE Id = '${catalogId}'`;
  catalogQuery += " ORDER BY Name";

  const catalogResp = await conn.query<{
    Id: string;
    Name: string;
    vlocity_cmt__CatalogCode__c: string | null;
  }>(catalogQuery);

  const catalogIds = catalogResp.records.map((r) => r.Id);

  // ObjectClass tree (independent of Catalog in Vlocity)
  const objectClasses = await queryObjectClassTree(conn);

  if (catalogIds.length === 0) {
    return { catalogs: [], objectClasses };
  }

  // 2. CatalogProductRelationship rows.
  // Filter out rows where the product ref is null — those represent
  // catalog-promotion relationships (Product2Id is null, PromotionId is populated)
  // and would crash the downstream Product2 IN-clause.
  const idsStr = catalogIds.map((id) => `'${id}'`).join(",");
  const totalLimit = productLimit * catalogIds.length;
  const rels = await conn.query<{
    vlocity_cmt__CatalogId__c: string;
    vlocity_cmt__Product2Id__c: string | null;
  }>(
    `SELECT vlocity_cmt__CatalogId__c, vlocity_cmt__Product2Id__c ` +
      `FROM vlocity_cmt__CatalogProductRelationship__c ` +
      `WHERE vlocity_cmt__CatalogId__c IN (${idsStr}) ` +
      `AND vlocity_cmt__Product2Id__c != null ` +
      `LIMIT ${totalLimit}`
  );

  const productIds = Array.from(
    new Set(
      rels.records
        .map((r) => r.vlocity_cmt__Product2Id__c)
        .filter((id): id is string => id !== null)
    )
  );

  // 3. Product2 details
  let productMap = new Map<string, ProductSummary>();
  if (productIds.length > 0) {
    const productIdsStr = productIds.map((id) => `'${id}'`).join(",");
    let q =
      `SELECT Id, Name, ProductCode, IsActive, vlocity_cmt__ObjectTypeId__c ` +
      `FROM Product2 WHERE Id IN (${productIdsStr})`;
    if (!includeInactive) q += " AND IsActive = true";
    const prodResp = await conn.query<{
      Id: string;
      Name: string;
      ProductCode: string | null;
      IsActive: boolean;
      vlocity_cmt__ObjectTypeId__c: string | null;
    }>(q);
    for (const p of prodResp.records) {
      productMap.set(p.Id, {
        id: p.Id,
        name: p.Name,
        productCode: p.ProductCode,
        isActive: p.IsActive,
        objectClassId: p.vlocity_cmt__ObjectTypeId__c,
      });
    }
  }

  // 4. Build catalog -> products
  const productsByCatalog = new Map<string, ProductSummary[]>();
  for (const rel of rels.records) {
    if (rel.vlocity_cmt__Product2Id__c === null) continue;
    const product = productMap.get(rel.vlocity_cmt__Product2Id__c);
    if (!product) continue; // either inactive (filtered out) or unknown
    const list =
      productsByCatalog.get(rel.vlocity_cmt__CatalogId__c) ?? [];
    list.push(product);
    productsByCatalog.set(rel.vlocity_cmt__CatalogId__c, list);
  }

  const catalogs: VlocityCatalog[] = catalogResp.records.map((c) => ({
    id: c.Id,
    name: c.Name,
    code: c.vlocity_cmt__CatalogCode__c,
    products: productsByCatalog.get(c.Id) ?? [],
  }));

  return { catalogs, objectClasses };
}

async function queryObjectClassTree(
  conn: Connection
): Promise<VlocityObjectClassNode[]> {
  const resp = await conn.query<{
    Id: string;
    Name: string;
    vlocity_cmt__ParentObjectClassId__c: string | null;
  }>(
    "SELECT Id, Name, vlocity_cmt__ParentObjectClassId__c " +
      "FROM vlocity_cmt__ObjectClass__c ORDER BY Name"
  );

  const nodeMap = new Map<string, VlocityObjectClassNode>();
  for (const r of resp.records) {
    nodeMap.set(r.Id, {
      id: r.Id,
      name: r.Name,
      parentObjectClassId: r.vlocity_cmt__ParentObjectClassId__c,
      children: [],
    });
  }

  const roots: VlocityObjectClassNode[] = [];
  for (const node of nodeMap.values()) {
    if (
      node.parentObjectClassId &&
      nodeMap.has(node.parentObjectClassId)
    ) {
      nodeMap.get(node.parentObjectClassId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// -----------------------------------------------------------------------------
// Standard NS strategy
// -----------------------------------------------------------------------------

async function queryStandardModel(
  conn: Connection,
  catalogId: string | undefined,
  includeInactive: boolean,
  productLimit: number
): Promise<{ catalogs: StandardCatalog[] }> {
  // 1. Catalogs.
  // ProductCatalog has no IsActive column (active-window is represented by
  // EffectiveStartDate / EffectiveEndDate in newer orgs, and absent entirely
  // in older orgs like kyocera-comms). For MVP we query only the universally
  // available fields and rely on Product2.IsActive for the active filter.
  let catalogQuery = "SELECT Id, Name FROM ProductCatalog";
  if (catalogId) catalogQuery += ` WHERE Id = '${catalogId}'`;
  catalogQuery += " ORDER BY Name";

  const catalogResp = await conn.query<{
    Id: string;
    Name: string;
  }>(catalogQuery);

  const catalogIds = catalogResp.records.map((r) => r.Id);
  if (catalogIds.length === 0) {
    return { catalogs: [] };
  }

  const idsStr = catalogIds.map((id) => `'${id}'`).join(",");

  // 2. Categories under these catalogs
  const catResp = await conn.query<{
    Id: string;
    Name: string;
    CatalogId: string;
    ParentCategoryId: string | null;
  }>(
    `SELECT Id, Name, CatalogId, ParentCategoryId FROM ProductCategory ` +
      `WHERE CatalogId IN (${idsStr}) ORDER BY Name`
  );

  // 3. ProductCategoryProduct rows (junction)
  const totalLimit = productLimit * catalogIds.length;
  const linkResp = await conn.query<{
    ProductId: string;
    ProductCategoryId: string | null;
    CatalogId: string;
  }>(
    `SELECT ProductId, ProductCategoryId, CatalogId FROM ProductCategoryProduct ` +
      `WHERE CatalogId IN (${idsStr}) LIMIT ${totalLimit}`
  );

  const productIds = Array.from(
    new Set(linkResp.records.map((l) => l.ProductId))
  );

  // 4. Product2 details
  const productMap = new Map<string, ProductSummary>();
  if (productIds.length > 0) {
    const productIdsStr = productIds.map((id) => `'${id}'`).join(",");
    let q =
      `SELECT Id, Name, ProductCode, IsActive FROM Product2 ` +
      `WHERE Id IN (${productIdsStr})`;
    if (!includeInactive) q += " AND IsActive = true";
    const prodResp = await conn.query<{
      Id: string;
      Name: string;
      ProductCode: string | null;
      IsActive: boolean;
    }>(q);
    for (const p of prodResp.records) {
      productMap.set(p.Id, {
        id: p.Id,
        name: p.Name,
        productCode: p.ProductCode,
        isActive: p.IsActive,
      });
    }
  }

  // 5. Build category nodes
  const categoryMap = new Map<string, StandardCategoryNode>();
  const categoriesByCatalog = new Map<string, StandardCategoryNode[]>();

  for (const c of catResp.records) {
    const node: StandardCategoryNode = {
      id: c.Id,
      name: c.Name,
      parentCategoryId: c.ParentCategoryId,
      children: [],
      products: [],
    };
    categoryMap.set(c.Id, node);
    const list = categoriesByCatalog.get(c.CatalogId) ?? [];
    list.push(node);
    categoriesByCatalog.set(c.CatalogId, list);
  }

  // Build tree per catalog, with roots = nodes whose parent is null or
  // whose parent lives in a different catalog (rare but possible).
  const rootsByCatalog = new Map<string, StandardCategoryNode[]>();
  for (const [catId, cats] of categoriesByCatalog) {
    const roots: StandardCategoryNode[] = [];
    for (const c of cats) {
      const parentNode =
        c.parentCategoryId !== null
          ? categoryMap.get(c.parentCategoryId)
          : undefined;
      // Only nest under parent if parent is in the same catalog
      const parentInSameCatalog =
        parentNode && (categoriesByCatalog.get(catId) ?? []).includes(parentNode);
      if (parentInSameCatalog && parentNode) {
        parentNode.children.push(c);
      } else {
        roots.push(c);
      }
    }
    rootsByCatalog.set(catId, roots);
  }

  // 6. Attach products to categories
  // ProductCategoryProduct rows can have a null ProductCategoryId
  // (catalog-level products); we attach those as 'uncategorized' under root level.
  const uncategorizedByCatalog = new Map<string, ProductSummary[]>();
  for (const link of linkResp.records) {
    const product = productMap.get(link.ProductId);
    if (!product) continue;
    if (
      link.ProductCategoryId &&
      categoryMap.has(link.ProductCategoryId)
    ) {
      categoryMap.get(link.ProductCategoryId)!.products.push(product);
    } else {
      const list = uncategorizedByCatalog.get(link.CatalogId) ?? [];
      list.push(product);
      uncategorizedByCatalog.set(link.CatalogId, list);
    }
  }

  // 7. Assemble final result
  const catalogs: StandardCatalog[] = catalogResp.records.map((c) => {
    const roots = rootsByCatalog.get(c.Id) ?? [];
    const uncategorized = uncategorizedByCatalog.get(c.Id) ?? [];
    if (uncategorized.length > 0) {
      // Surface uncategorized products as a synthetic node so they aren't lost.
      roots.push({
        id: `__uncategorized__${c.Id}`,
        name: "(Uncategorized — products linked to catalog without a category)",
        parentCategoryId: null,
        children: [],
        products: uncategorized,
      });
    }
    return {
      id: c.Id,
      name: c.Name,
      categories: roots,
    };
  });

  return { catalogs };
}
