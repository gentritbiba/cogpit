import { asRecord } from "../../shared/objects"
import type {
  ElicitationFieldOption,
  MissionControlElicitationField,
} from "../../shared/contracts/agentPrompts"

/**
 * What Cogpit can render for a form-mode MCP elicitation, or why it cannot.
 *
 * Declining a schema outright beats parking it: a parked prompt the UI can
 * never draw blocks the MCP server until its own timeout with nothing on
 * screen.
 */
export type ElicitationSchemaProjection =
  | { fields: MissionControlElicitationField[] }
  | { unsupported: string }

function describeSchemaType(type: unknown): string {
  if (type === undefined) return "is an untyped field"
  if (type === "array") return "is an array"
  if (type === "object") return "is a nested object"
  return `is a ${String(type)}`
}

function elicitationDefault(prop: Record<string, unknown>): { defaultValue?: string | number | boolean } {
  const value = prop.default
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? { defaultValue: value }
    : {}
}

/** Titled choices, which the MCP schema spells as `oneOf: [{ const, title }]`. */
function titledOptions(oneOf: unknown[]): ElicitationFieldOption[] | null {
  const options: ElicitationFieldOption[] = []
  for (const entry of oneOf) {
    const option = asRecord(entry)
    if (!option || typeof option.const !== "string") return null
    options.push({
      value: option.const,
      label: typeof option.title === "string" && option.title ? option.title : option.const,
    })
  }
  return options
}

/** A field, or a sentence tail explaining why it cannot be drawn. */
function projectElicitationField(
  name: string,
  prop: Record<string, unknown>,
  required: boolean,
): MissionControlElicitationField | string {
  const base = {
    name,
    label: typeof prop.title === "string" && prop.title ? prop.title : name,
    required,
    ...(typeof prop.description === "string" && prop.description
      ? { description: prop.description }
      : {}),
  }

  if (Array.isArray(prop.enum)) {
    if (!prop.enum.every((value) => typeof value === "string")) {
      return "is an enum of non-string values"
    }
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : []
    return {
      ...base,
      type: "enum",
      options: prop.enum.map((value, index) => ({
        value: value as string,
        label: typeof names[index] === "string" ? (names[index] as string) : (value as string),
      })),
      ...elicitationDefault(prop),
    }
  }

  if (Array.isArray(prop.oneOf)) {
    const options = titledOptions(prop.oneOf)
    if (!options) return "is a choice between non-string values"
    return { ...base, type: "enum", options, ...elicitationDefault(prop) }
  }

  const type = prop.type
  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    return { ...base, type, ...elicitationDefault(prop) }
  }
  return `${describeSchemaType(type)}, which Cogpit cannot render`
}

export function projectElicitationSchema(schema: Record<string, unknown> | undefined): ElicitationSchemaProjection {
  if (!schema) return { fields: [] }
  if (schema.type !== undefined && schema.type !== "object") {
    return { unsupported: `the request ${describeSchemaType(schema.type)}` }
  }
  const properties = asRecord(schema.properties) ?? {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  )
  const fields: MissionControlElicitationField[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const field = projectElicitationField(name, asRecord(raw) ?? {}, required.has(name))
    if (typeof field === "string") return { unsupported: `"${name}" ${field}` }
    fields.push(field)
  }
  for (const name of required) {
    if (!(name in properties)) return { unsupported: `required field "${name}" has no schema` }
  }
  return { fields }
}
