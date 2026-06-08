import { z } from "zod";
import type { Connection } from "@salesforce/core";
import { BaseTool, type CallResult } from "./base-tool.js";
import { sObjectExists, isValidSalesforceId } from "../utils/sobject.js";

const inputSchema = z.object({
  productId: z
    .string()
    .describe(
      "Salesforce ID of the Product2 record to inspect (15- or 18-character ID)."
    ),
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
      "Which Comms Cloud model to query. 'auto' (default) uses whichever is detected; " +
        "on hybrid orgs both views are returned for the same product. " +
        "'vlocity_cmt' or 'standard' forces a single side."
    ),
  includeRawJsonAttribute: z
    .boolean()
    .optional()
    .describe(
      "Vlocity only: if true, the original vlocity_cmt__JSONAttribute__c text is included " +
        "verbatim alongside the parsed structure. Useful for debugging. Defaults to false."
    ),
});

type Input = z.infer<typeof inputSchema>;

// ---- Result types ---------------------------------------------------------

type ObjectClassPathNode = {
  id: string;
  name: string;
};

type ParsedAttribute = {
  code: string | null;
  name: string | null;
  label: string | null;
  dataType: string | null;
  value: unknown;
  defaultValue: unknown;
  isRequired: boolean | null;
};

type ParsedAttributeCategory = {
  code: string | null;
  name: string | null;
  attributes: ParsedAttribute[];
};

type VlocityProductDetail = {
  id: string;
  name: string;
  productCode: string | null;
  description: string | null;
  family: string | null;
  isActive: boolean;
  specificationType: string | null;
  subType: string | null;
  status: string | null;
  isOrderable: boolean | null;
  isConfigurable: boolean | null;
  globalKey: string | null;
  objectClass: {
    id: string | null;
    name: string | null;
    path: ObjectClassPathNode[];
  };
  attributeCategories: ParsedAttributeCategory[];
  attributeMetadataPresent: boolean;
  jsonAttributePresent: boolean;
  rawJsonAttribute?: string;
};

type StandardCategoryRef = {
  id: string;
  name: string;
  catalogId: string;
  catalogName: string | null;
};

type StandardAttribute = {
  productAttributeDefinitionId: string;
  attributeDefinitionId: string;
  name: string | null;
  label: string | null;
  code: string | null;
  developerName: string | null;
  dataType: string | null;
  isRequired: boolean | null;
  defaultValue: string | null;
  description: string | null;
  category: { id: string; name: string | null } | null;
};

type StandardProductDetail = {
  id: string;
  name: string;
  productCode: string | null;
  description: string | null;
  family: string | null;
  isActive: boolean;
  categories: StandardCategoryRef[];
  attributes: StandardAttribute[];
};

// ---- Tool -----------------------------------------------------------------

export class GetProductDetailsTool extends BaseTool {
  getName(): string {
    return "get_product_details";
  }

  getConfig() {
    return {
      description:
        "Returns the full picture for a single Product2: core fields, its place in the catalog hierarchy, " +
        "and the attributes that apply to it. " +
        "On Vlocity CMT orgs, this includes the resolved ObjectClass path and a parsed view of " +
        "vlocity_cmt__JSONAttribute__c (the per-product attribute BLOB). " +
        "On standard NS orgs, this includes the ProductCategory memberships and the AttributeDefinition records " +
        "linked via ProductAttributeDefinition. " +
        "Use after list_products has surfaced a candidate productId.",
      inputSchema,
    };
  }

  async exec(args: Record<string, unknown>): Promise<CallResult> {
    try {
      const parsed: Input = inputSchema.parse(args);

      if (!isValidSalesforceId(parsed.productId)) {
        return errorResult(
          `Invalid productId '${parsed.productId}'. Expected a 15- or 18-character Salesforce ID.`
        );
      }

      const conn = await this.ctx.sfClient.getConnection(parsed.targetOrg);
      const requestedMode = parsed.mode ?? "auto";
      const includeRaw = parsed.includeRawJsonAttribute ?? false;

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
        productId: parsed.productId,
        details: {
          orgUsername: conn.getUsername(),
          instanceUrl: conn.instanceUrl,
          apiVersion: conn.getApiVersion(),
        },
      };

      if (queryVlocity) {
        result.vlocity_cmt = await fetchVlocityDetail(
          conn,
          parsed.productId,
          includeRaw
        );
      }
      if (queryStandard) {
        result.standard = await fetchStandardDetail(conn, parsed.productId);
      }

      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Error getting product details: ${msg}`);
    }
  }
}

// ---- Helpers --------------------------------------------------------------

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

// ---- Vlocity CMT side ------------------------------------------------------

async function fetchVlocityDetail(
  conn: Connection,
  productId: string,
  includeRaw: boolean
): Promise<VlocityProductDetail | null> {
  const resp = await conn.query<{
    Id: string;
    Name: string;
    ProductCode: string | null;
    Description: string | null;
    Family: string | null;
    IsActive: boolean;
    vlocity_cmt__SpecificationType__c: string | null;
    vlocity_cmt__SubType__c: string | null;
    vlocity_cmt__Status__c: string | null;
    vlocity_cmt__IsOrderable__c: boolean | null;
    vlocity_cmt__IsConfigurable__c: boolean | null;
    vlocity_cmt__GlobalKey__c: string | null;
    vlocity_cmt__ObjectTypeId__c: string | null;
    vlocity_cmt__JSONAttribute__c: string | null;
    vlocity_cmt__AttributeMetadata__c: string | null;
  }>(
    `SELECT Id, Name, ProductCode, Description, Family, IsActive, ` +
      `vlocity_cmt__SpecificationType__c, vlocity_cmt__SubType__c, ` +
      `vlocity_cmt__Status__c, vlocity_cmt__IsOrderable__c, ` +
      `vlocity_cmt__IsConfigurable__c, vlocity_cmt__GlobalKey__c, ` +
      `vlocity_cmt__ObjectTypeId__c, vlocity_cmt__JSONAttribute__c, ` +
      `vlocity_cmt__AttributeMetadata__c ` +
      `FROM Product2 WHERE Id = '${productId}' LIMIT 1`
  );

  if (resp.records.length === 0) {
    return null;
  }

  const p = resp.records[0];

  // Resolve ObjectClass path by walking parent links upward.
  const objectClassPath = p.vlocity_cmt__ObjectTypeId__c
    ? await resolveObjectClassPath(conn, p.vlocity_cmt__ObjectTypeId__c)
    : [];

  // Parse JSON BLOB if populated.
  const attributeCategories = parseVlocityJsonAttribute(
    p.vlocity_cmt__JSONAttribute__c
  );

  const detail: VlocityProductDetail = {
    id: p.Id,
    name: p.Name,
    productCode: p.ProductCode,
    description: p.Description,
    family: p.Family,
    isActive: p.IsActive,
    specificationType: p.vlocity_cmt__SpecificationType__c,
    subType: p.vlocity_cmt__SubType__c,
    status: p.vlocity_cmt__Status__c,
    isOrderable: p.vlocity_cmt__IsOrderable__c,
    isConfigurable: p.vlocity_cmt__IsConfigurable__c,
    globalKey: p.vlocity_cmt__GlobalKey__c,
    objectClass: {
      id: p.vlocity_cmt__ObjectTypeId__c,
      name: objectClassPath.length > 0
        ? objectClassPath[objectClassPath.length - 1].name
        : null,
      path: objectClassPath,
    },
    attributeCategories,
    attributeMetadataPresent: !!p.vlocity_cmt__AttributeMetadata__c,
    jsonAttributePresent: !!p.vlocity_cmt__JSONAttribute__c,
  };

  if (includeRaw && p.vlocity_cmt__JSONAttribute__c) {
    detail.rawJsonAttribute = p.vlocity_cmt__JSONAttribute__c;
  }

  return detail;
}

type ObjectClassRow = {
  Id: string;
  Name: string;
  vlocity_cmt__ParentObjectClassId__c: string | null;
};

async function resolveObjectClassPath(
  conn: Connection,
  startId: string
): Promise<ObjectClassPathNode[]> {
  // Cap traversal to avoid pathological loops.
  const maxHops = 10;
  const path: ObjectClassPathNode[] = [];
  let currentId: string | null = startId;
  let hops = 0;

  while (currentId !== null && hops < maxHops) {
    const resp = await conn.query<ObjectClassRow>(
      `SELECT Id, Name, vlocity_cmt__ParentObjectClassId__c ` +
        `FROM vlocity_cmt__ObjectClass__c WHERE Id = '${currentId}' LIMIT 1`
    );
    if (resp.records.length === 0) break;
    const rec: ObjectClassRow = resp.records[0];
    path.unshift({ id: rec.Id, name: rec.Name });
    currentId = rec.vlocity_cmt__ParentObjectClassId__c;
    hops += 1;
  }
  return path;
}

/**
 * Parse the JSON BLOB stored in vlocity_cmt__JSONAttribute__c.
 *
 * Two shapes have been observed in the wild:
 *
 * Shape A — keyed object (modern Vlocity):
 *   {
 *     "ACAT_Phones": [
 *       {
 *         "categorycode__c": "ACAT_Phones",
 *         "categoryname__c": "Mobile Devices",
 *         "attributeuniquecode__c": "ATT_DT_BRD",
 *         "attributedisplayname__c": "Brand",
 *         "attributerunningdatatype__c": "Text",
 *         "value__c": "Infiwave",
 *         ...
 *       },
 *       ...
 *     ],
 *     "ACAT_Other": [ ... ]
 *   }
 *
 * Shape B — array with nested records (older Vlocity):
 *   [
 *     {
 *       "Code__c": "ACAT_X",
 *       "Name__c": "Category Display Name",
 *       "productAttributes": { "records": [
 *         { "Code__c": "...", "Name__c": "...", "label": "...", "dataType": "...",
 *           "value__c": "...", ... }
 *       ] }
 *     }
 *   ]
 *
 * Returns [] on parse error or unknown shape.
 */
function parseVlocityJsonAttribute(
  raw: string | null
): ParsedAttributeCategory[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  // Shape A: keyed object
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parseShapeA(parsed as Record<string, unknown>);
  }

  // Shape B: array of category entries
  if (Array.isArray(parsed)) {
    return parseShapeB(parsed);
  }

  return [];
}

function parseShapeA(
  obj: Record<string, unknown>
): ParsedAttributeCategory[] {
  const out: ParsedAttributeCategory[] = [];
  for (const [categoryKey, value] of Object.entries(obj)) {
    if (!Array.isArray(value)) continue;
    const attrs: ParsedAttribute[] = [];
    let categoryName: string | null = null;

    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (categoryName === null) {
        categoryName = asStringOrNull(r["categoryname__c"]);
      }
      // dataType lives in different fields depending on Vlocity version /
      // configuration. Search a few known locations before giving up.
      // Field names observed in real BLOBs:
      //   - valuedatatype__c        (modern Vlocity, top-level)
      //   - attributerunningdatatype__c (older versions, top-level)
      //   - dataType                (some imports, top-level)
      //   - attributeRunTimeInfo.dataType (nested under runtime info object)
      const runtimeInfo = r["attributeRunTimeInfo"] as
        | Record<string, unknown>
        | undefined;
      const dataTypeValue =
        r["valuedatatype__c"] ??
        r["attributerunningdatatype__c"] ??
        r["dataType"] ??
        r["inputType"] ??
        runtimeInfo?.["dataType"] ??
        null;

      attrs.push({
        code: asStringOrNull(
          r["attributeuniquecode__c"] ?? r["Code__c"] ?? r["code"]
        ),
        name: asStringOrNull(
          r["attributedisplayname__c"] ?? r["Name__c"] ?? r["name"]
        ),
        label: asStringOrNull(
          r["attributedisplayname__c"] ?? r["label"] ?? r["displayLabel"]
        ),
        dataType: asStringOrNull(dataTypeValue),
        value: r["value__c"] ?? r["userValues"] ?? r["value"] ?? null,
        defaultValue:
          r["defaultValue__c"] ?? r["defaultValue"] ?? null,
        isRequired: asBooleanOrNull(
          r["isrequired__c"] ?? r["required"] ?? r["isRequired"]
        ),
      });
    }

    out.push({
      code: categoryKey,
      name: categoryName,
      attributes: attrs,
    });
  }
  return out;
}

function parseShapeB(arr: unknown[]): ParsedAttributeCategory[] {
  const out: ParsedAttributeCategory[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const categoryAttrs: ParsedAttribute[] = [];

    const productAttributes = e.productAttributes as
      | Record<string, unknown>
      | undefined;
    const records = productAttributes?.records as unknown[] | undefined;

    if (Array.isArray(records)) {
      for (const rec of records) {
        if (!rec || typeof rec !== "object") continue;
        const r = rec as Record<string, unknown>;
        categoryAttrs.push({
          code: asStringOrNull(r["Code__c"] ?? r["code"]),
          name: asStringOrNull(r["Name__c"] ?? r["name"]),
          label: asStringOrNull(r["label"] ?? r["displayLabel"]),
          dataType: asStringOrNull(r["dataType"] ?? r["inputType"]),
          value: r["value__c"] ?? r["userValues"] ?? r["value"] ?? null,
          defaultValue:
            r["defaultValue"] ?? r["defaultValue__c"] ?? null,
          isRequired: asBooleanOrNull(
            r["required"] ?? r["isRequired"]
          ),
        });
      }
    }

    out.push({
      code: asStringOrNull(e["Code__c"] ?? e["code"]),
      name: asStringOrNull(
        e["categoryDisplayName"] ?? e["Name__c"] ?? e["name"]
      ),
      attributes: categoryAttrs,
    });
  }
  return out;
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asBooleanOrNull(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return null;
}

// ---- Standard NS side ------------------------------------------------------

async function fetchStandardDetail(
  conn: Connection,
  productId: string
): Promise<StandardProductDetail | null> {
  const prodResp = await conn.query<{
    Id: string;
    Name: string;
    ProductCode: string | null;
    Description: string | null;
    Family: string | null;
    IsActive: boolean;
  }>(
    `SELECT Id, Name, ProductCode, Description, Family, IsActive ` +
      `FROM Product2 WHERE Id = '${productId}' LIMIT 1`
  );

  if (prodResp.records.length === 0) {
    return null;
  }
  const p = prodResp.records[0];

  // Categories this product belongs to (with catalog name).
  const categoryResp = await conn.query<{
    ProductCategoryId: string | null;
    CatalogId: string;
  }>(
    `SELECT ProductCategoryId, CatalogId FROM ProductCategoryProduct ` +
      `WHERE ProductId = '${productId}'`
  );

  const categoryIds = Array.from(
    new Set(
      categoryResp.records
        .map((r) => r.ProductCategoryId)
        .filter((id): id is string => id !== null)
    )
  );
  const catalogIds = Array.from(
    new Set(categoryResp.records.map((r) => r.CatalogId))
  );

  const categoryMap = new Map<string, string>();
  if (categoryIds.length > 0) {
    const ids = categoryIds.map((id) => `'${id}'`).join(",");
    const r = await conn.query<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM ProductCategory WHERE Id IN (${ids})`
    );
    for (const c of r.records) categoryMap.set(c.Id, c.Name);
  }

  const catalogMap = new Map<string, string>();
  if (catalogIds.length > 0) {
    const ids = catalogIds.map((id) => `'${id}'`).join(",");
    const r = await conn.query<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM ProductCatalog WHERE Id IN (${ids})`
    );
    for (const c of r.records) catalogMap.set(c.Id, c.Name);
  }

  const categories: StandardCategoryRef[] = categoryResp.records
    .filter((r) => r.ProductCategoryId !== null)
    .map((r) => ({
      id: r.ProductCategoryId!,
      name: categoryMap.get(r.ProductCategoryId!) ?? "",
      catalogId: r.CatalogId,
      catalogName: catalogMap.get(r.CatalogId) ?? null,
    }));

  // Attributes via ProductAttributeDefinition. Some standard-NS orgs ship the
  // PCM catalog objects but not the full attribute model (hybrid-org is one
  // such org). Skip gracefully if the object isn't present.
  if (!(await sObjectExists(conn, "ProductAttributeDefinition"))) {
    return {
      id: p.Id,
      name: p.Name,
      productCode: p.ProductCode,
      description: p.Description,
      family: p.Family,
      isActive: p.IsActive,
      categories,
      attributes: [],
    };
  }

  const padResp = await conn.query<{
    Id: string;
    AttributeDefinitionId: string;
    AttributeCategoryId: string | null;
  }>(
    `SELECT Id, AttributeDefinitionId, AttributeCategoryId ` +
      `FROM ProductAttributeDefinition WHERE Product2Id = '${productId}'`
  );

  const attrDefIds = Array.from(
    new Set(padResp.records.map((r) => r.AttributeDefinitionId))
  );
  const attrCategoryIds = Array.from(
    new Set(
      padResp.records
        .map((r) => r.AttributeCategoryId)
        .filter((id): id is string => id !== null)
    )
  );

  const attrDefMap = new Map<
    string,
    {
      Name: string | null;
      Label: string | null;
      Code: string | null;
      DeveloperName: string | null;
      DataType: string | null;
      IsRequired: boolean | null;
      DefaultValue: string | null;
      Description: string | null;
    }
  >();
  if (attrDefIds.length > 0) {
    const ids = attrDefIds.map((id) => `'${id}'`).join(",");
    const r = await conn.query<{
      Id: string;
      Name: string | null;
      Label: string | null;
      Code: string | null;
      DeveloperName: string | null;
      DataType: string | null;
      IsRequired: boolean | null;
      DefaultValue: string | null;
      Description: string | null;
    }>(
      `SELECT Id, Name, Label, Code, DeveloperName, DataType, IsRequired, ` +
        `DefaultValue, Description FROM AttributeDefinition WHERE Id IN (${ids})`
    );
    for (const d of r.records) {
      attrDefMap.set(d.Id, d);
    }
  }

  const attrCategoryMap = new Map<string, string>();
  if (
    attrCategoryIds.length > 0 &&
    (await sObjectExists(conn, "AttributeCategory"))
  ) {
    const ids = attrCategoryIds.map((id) => `'${id}'`).join(",");
    const r = await conn.query<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM AttributeCategory WHERE Id IN (${ids})`
    );
    for (const c of r.records) attrCategoryMap.set(c.Id, c.Name);
  }

  const attributes: StandardAttribute[] = padResp.records.map((pad) => {
    const def = attrDefMap.get(pad.AttributeDefinitionId);
    return {
      productAttributeDefinitionId: pad.Id,
      attributeDefinitionId: pad.AttributeDefinitionId,
      name: def?.Name ?? null,
      label: def?.Label ?? null,
      code: def?.Code ?? null,
      developerName: def?.DeveloperName ?? null,
      dataType: def?.DataType ?? null,
      isRequired: def?.IsRequired ?? null,
      defaultValue: def?.DefaultValue ?? null,
      description: def?.Description ?? null,
      category: pad.AttributeCategoryId
        ? {
            id: pad.AttributeCategoryId,
            name: attrCategoryMap.get(pad.AttributeCategoryId) ?? null,
          }
        : null,
    };
  });

  return {
    id: p.Id,
    name: p.Name,
    productCode: p.ProductCode,
    description: p.Description,
    family: p.Family,
    isActive: p.IsActive,
    categories,
    attributes,
  };
}
