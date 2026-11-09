// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Each turn boundary moved back over the run of records just before it that
 * `travelsWithNextTurn` names: records a format writes ahead of a turn and
 * holds for it, which a page starting at the bare boundary would leave on the
 * page above, attached to the wrong turn.
 */
export function cutsBeforeBoundaries(
  boundaries: readonly number[],
  records: readonly Record<string, unknown>[],
  travelsWithNextTurn: (record: Record<string, unknown>) => boolean,
): number[] {
  return boundaries.map((boundary, index) => {
    const floor = index === 0 ? 0 : boundaries[index - 1] + 1
    let cut = boundary
    while (cut > floor && travelsWithNextTurn(records[cut - 1])) cut--
    return cut
  })
}

/** A transcript line as page cuts read it: a JSON object, or null. */
export function parsePageRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * The leading lines of a transcript's header that come before its first turn:
 * what every page is parsed after. Header lines past that point belong to the
 * first turn, and prepending them to a later page would open a phantom turn.
 */
export function linesBeforeFirstTurn(
  format: { pageCuts(records: readonly Record<string, unknown>[]): number[] },
  lines: readonly string[],
): string[] {
  const records: Record<string, unknown>[] = []
  const lineOf: number[] = []
  lines.forEach((line, index) => {
    const record = parsePageRecord(line)
    if (!record) return
    records.push(record)
    lineOf.push(index)
  })
  const [firstCut] = format.pageCuts(records)
  return firstCut === undefined ? [...lines] : lines.slice(0, lineOf[firstCut])
}
