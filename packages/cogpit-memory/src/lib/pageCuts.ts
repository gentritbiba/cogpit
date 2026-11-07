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
