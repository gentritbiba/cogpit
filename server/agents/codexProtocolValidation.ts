import bundle from "./generated/codex-protocol.schema.json"
interface Schema { $ref?: string; type?: string | string[]; enum?: unknown[]; const?: unknown; oneOf?: Schema[]; anyOf?: Schema[]; allOf?: Schema[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema }
const definitions = bundle.definitions as unknown as Record<string, Schema>
function matches(schema: Schema, value: unknown): boolean {
  if (schema.$ref) return matches(definitions[schema.$ref.split("/").at(-1)!]!, value)
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf)!.some((choice) => matches(choice, value))
  if (schema.allOf && !schema.allOf.every((choice) => matches(choice, value))) return false
  if (schema.const !== undefined && schema.const !== value) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  const types = typeof schema.type === "string" ? [schema.type] : schema.type
  if (types && !types.some((type) => type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : type === "integer" ? Number.isSafeInteger(value) : typeof value === type)) return false
  if (Array.isArray(value) && schema.items && !value.every((item) => matches(schema.items!, item))) return false
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (schema.required?.some((field) => !(field in record))) return false
    if (schema.properties && Object.entries(schema.properties).some(([field, shape]) => field in record && !matches(shape, record[field]))) return false
  }
  return true
}
export function validateCodexRequest(method: string, params: unknown): void {
  const name = (bundle.requests as Record<string, string>)[method]
  if (name && !matches(definitions[name]!, params ?? {})) throw new Error(`Codex ${bundle.version} request contract rejected ${method}`)
}
