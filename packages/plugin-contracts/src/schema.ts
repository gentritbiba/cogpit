import { z } from "zod"
import { ContractValidationError, parseJson, utf8Length } from "./json.js"

export const identifier = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/u)
  .refine((value) => !["constructor", "prototype", "__proto__"].includes(value), "Reserved identifier")
export const label = z.string().min(1).max(128).refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127), "Control characters are forbidden")
export const boundedText = (maxBytes: number) => z.string().refine((value) => utf8Length(value) <= maxBytes, "Text exceeds byte limit")
export const canonicalPath = z.string().min(1).max(256).refine((value) => {
  if (!/^[A-Za-z0-9_./-]+$/u.test(value)) return false
  return value.split("/").every((part) => part !== "" && part !== "." && part !== ".."
    && !part.endsWith(".") && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))
}, "Expected a canonical portable package path")

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown, maxBytes: number, maxNodes?: number): T {
  const result = schema.safeParse(parseJson(value, { maxBytes, maxNodes }))
  if (!result.success) throw new ContractValidationError(result.error.issues.map((issue) => ({
    path: issue.path.length ? `$.${issue.path.map(String).join(".")}` : "$", message: issue.message,
  })))
  return result.data
}
