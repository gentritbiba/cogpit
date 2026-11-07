/** Whether two parsed JSON values are equal, stopping at the first difference. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) if (!jsonEqual(a[index], b[index])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) if (!Object.hasOwn(right, key) || !jsonEqual(left[key], right[key])) return false
  return true
}
