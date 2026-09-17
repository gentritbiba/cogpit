export function isValidContextWindowTokens(value: unknown): value is number | null | undefined {
  return value === undefined || value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
}
