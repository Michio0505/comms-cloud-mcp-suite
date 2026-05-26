import type { Connection } from "@salesforce/core";

/**
 * Returns true if the given sObject is queryable in the connected org.
 * Used to fingerprint a namespace's presence and to gate strategy selection.
 */
export async function sObjectExists(
  conn: Connection,
  sObjectName: string
): Promise<boolean> {
  try {
    await conn.sobject(sObjectName).describe();
    return true;
  } catch {
    return false;
  }
}

/**
 * Lightweight Salesforce 15/18-char ID validator.
 * We reject anything else to avoid passing LLM-generated free text into SOQL.
 */
export function isValidSalesforceId(id: string): boolean {
  return /^[a-zA-Z0-9]{15,18}$/.test(id);
}
