import { splitDiffLines } from "../../../shared/diff-utils"

export interface DiffLine {
  type: "added" | "removed" | "unchanged"
  text: string
  oldIdx?: number
  newIdx?: number
}

/** Size threshold — beyond this, skip LCS and show simple removed/added blocks. */
const LCS_MAX_PRODUCT = 250_000

function* diffSteps(oldStr: string, newStr: string): Generator<void, DiffLine[]> {
  const oldLines = splitDiffLines(oldStr)
  const newLines = splitDiffLines(newStr)
  const m = oldLines.length
  const n = newLines.length

  // Trim common prefix/suffix — typical edits share 90%+ lines,
  // so this dramatically shrinks the LCS matrix.
  let prefix = 0
  while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) {
    prefix++
    if (prefix % 2048 === 0) yield
  }
  let suffix = 0
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    oldLines[m - 1 - suffix] === newLines[n - 1 - suffix]
  ) {
    suffix++
    if (suffix % 2048 === 0) yield
  }

  const om = m - prefix - suffix
  const on = n - prefix - suffix

  const result: DiffLine[] = []

  // Prefix unchanged lines
  for (let k = 0; k < prefix; k++) {
    if (k % 2048 === 0) yield
    result.push({ type: "unchanged", text: oldLines[k], oldIdx: k, newIdx: k })
  }

  if (om === 0 && on === 0) {
    // No middle — just prefix+suffix
  } else if (om === 0) {
    for (let k = 0; k < on; k++) {
      if (k % 2048 === 0) yield
      result.push({ type: "added", text: newLines[prefix + k], newIdx: prefix + k })
    }
  } else if (on === 0) {
    for (let k = 0; k < om; k++) {
      if (k % 2048 === 0) yield
      result.push({ type: "removed", text: oldLines[prefix + k], oldIdx: prefix + k })
    }
  } else if (om * on > LCS_MAX_PRODUCT) {
    // Fast path for very large diffs — skip LCS, show removed then added.
    for (let k = 0; k < om; k++) {
      if (k % 2048 === 0) yield
      result.push({ type: "removed", text: oldLines[prefix + k], oldIdx: prefix + k })
    }
    for (let k = 0; k < on; k++) {
      if (k % 2048 === 0) yield
      result.push({ type: "added", text: newLines[prefix + k], newIdx: prefix + k })
    }
  } else {
    // LCS on changed middle section — flat Int32Array (single allocation, pre-zeroed)
    const stride = on + 1
    const dp = new Int32Array((om + 1) * stride)
    for (let i = 1; i <= om; i++) {
      if (i % 16 === 0) yield
      const oldLine = oldLines[prefix + i - 1]
      const rowOff = i * stride
      const prevOff = rowOff - stride
      for (let j = 1; j <= on; j++) {
        if (oldLine === newLines[prefix + j - 1]) {
          dp[rowOff + j] = dp[prevOff + j - 1] + 1
        } else {
          const up = dp[prevOff + j]
          const left = dp[rowOff + j - 1]
          dp[rowOff + j] = up > left ? up : left
        }
      }
    }

    // Backtrack middle section
    const middle: DiffLine[] = []
    let i = om, j = on
    while (i > 0 || j > 0) {
      if ((i + j) % 2048 === 0) yield
      if (i > 0 && j > 0 && oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
        middle.push({ type: "unchanged", text: oldLines[prefix + i - 1], oldIdx: prefix + i - 1, newIdx: prefix + j - 1 })
        i--; j--
      } else if (j > 0 && (i === 0 || dp[i * stride + j - 1] >= dp[(i - 1) * stride + j])) {
        middle.push({ type: "added", text: newLines[prefix + j - 1], newIdx: prefix + j - 1 })
        j--
      } else {
        middle.push({ type: "removed", text: oldLines[prefix + i - 1], oldIdx: prefix + i - 1 })
        i--
      }
    }
    middle.reverse()
    for (let k = 0; k < middle.length; k++) {
      if (k % 2048 === 0) yield
      result.push(middle[k])
    }
  }

  // Suffix unchanged lines
  for (let k = 0; k < suffix; k++) {
    if (k % 2048 === 0) yield
    const oi = m - suffix + k
    const ni = n - suffix + k
    result.push({ type: "unchanged", text: oldLines[oi], oldIdx: oi, newIdx: ni })
  }

  return result
}

export function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const steps = diffSteps(oldStr, newStr)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

/** Same algorithm, yielding between batches when workers are unavailable. */
export async function computeDiffDeferred(oldStr: string, newStr: string, signal?: AbortSignal): Promise<DiffLine[]> {
  const steps = diffSteps(oldStr, newStr)
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    await new Promise(resolve => setTimeout(resolve, 0))
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const step = steps.next()
    if (step.done) return step.value
  }
}
