// Value coercions shared by the read-only integration routes.

export { asRecord as record } from "../../shared/objects"

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

export function clampLimit(raw: string | null, fallback: number, max: number): number {
  const requested = Number(raw ?? fallback)
  return Number.isInteger(requested) ? Math.min(max, Math.max(1, requested)) : fallback
}
