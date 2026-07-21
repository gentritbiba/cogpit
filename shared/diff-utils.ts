/** Count actually changed lines via LCS diff (matches EditDiffView logic exactly) */
export function diffLineCount(oldStr: string, newStr: string): { add: number; del: number } {
  if (!oldStr && !newStr) return { add: 0, del: 0 }
  const oldLines = oldStr ? oldStr.split("\n") : []
  const newLines = newStr ? newStr.split("\n") : []
  if (oldLines.length === 0) return { add: newLines.length, del: 0 }
  if (newLines.length === 0) return { add: 0, del: oldLines.length }

  const m = oldLines.length
  const n = newLines.length

  // Trim common prefix/suffix to shrink LCS matrix
  let prefix = 0
  while (prefix < m && prefix < n && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < m - prefix &&
    suffix < n - prefix &&
    oldLines[m - 1 - suffix] === newLines[n - 1 - suffix]
  ) suffix++

  const om = m - prefix - suffix
  const on = n - prefix - suffix
  if (om === 0) return { add: on, del: 0 }
  if (on === 0) return { add: 0, del: om }

  // Single-row LCS — O(on) memory instead of O(om * on).
  // We only need the LCS length, not the alignment, so no backtracking needed.
  let prev = new Array<number>(on + 1).fill(0)
  let curr = new Array<number>(on + 1).fill(0)
  for (let i = 1; i <= om; i++) {
    curr[0] = 0
    const oldLine = oldLines[prefix + i - 1]
    for (let j = 1; j <= on; j++) {
      if (oldLine === newLines[prefix + j - 1]) {
        curr[j] = prev[j - 1] + 1
      } else {
        curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1]
      }
    }
    ;[prev, curr] = [curr, prev]
  }

  const lcs = prev[on]
  return { add: on - lcs, del: om - lcs }
}

// ── Net diff across multiple edits ─────────────────────────────────────────

export interface EditOp {
  oldString: string
  newString: string
  /** If true, this replaces the entire file (Write tool). */
  isWrite: boolean
}

export interface NetDiffResult {
  /** Reconstructed content before edits (for diffing). */
  originalStr: string
  /** Reconstructed content after edits (for diffing). */
  currentStr: string
  addCount: number
  delCount: number
}

/**
 * Compute the net diff for a single file across multiple sequential edit operations.
 *
 * Uses region-based simulation: tracks "original" vs "current" content for each
 * independently edited region. When a later edit modifies text introduced by an
 * earlier edit, the regions chain — so the original stays as-is and only the
 * current content updates. This produces a proper before/after pair that can be
 * diffed with LCS to show context lines, unchanged regions, and real changes.
 *
 * Write operations replace all tracked regions (they overwrite the entire file).
 */
export function computeNetDiff(ops: EditOp[]): NetDiffResult {
  // Each region tracks a contiguous chunk of file content we've seen edited.
  // `original` = what was there before any edits in this sequence touched it.
  // `current`  = what's there now after applying edits.
  interface Region {
    original: string
    current: string
  }

  let regions: Region[] = []

  for (const op of ops) {
    if (op.isWrite) {
      // Write replaces entire file — all prior regions are superseded.
      // The Write content becomes both the "original baseline" and "current".
      // If subsequent Edits modify it, original stays and current diverges.
      regions = [{ original: op.newString, current: op.newString }]
      continue
    }

    // Empty old_string = insertion (new content only), always a new region.
    if (!op.oldString) {
      regions.push({ original: op.oldString, current: op.newString })
      continue
    }

    // Edit: try to find old_string inside an existing region's current content.
    // If found, this edit is chaining on a previous edit in the same region.
    let found = false
    for (const region of regions) {
      const idx = region.current.indexOf(op.oldString)
      if (idx !== -1) {
        region.current =
          region.current.slice(0, idx) +
          op.newString +
          region.current.slice(idx + op.oldString.length)
        found = true
        break
      }
    }

    if (!found) {
      // Check if a prior edit already transformed this content (duplicate/redundant edit).
      // If old_string exists in a region's original but not its current, it was already handled.
      const alreadyTransformed = regions.some(
        (r) => r.original.includes(op.oldString) && !r.current.includes(op.oldString)
      )
      if (alreadyTransformed) {
        // A prior edit already changed this region — this is a redundant/failed edit
        // (old_string no longer exists in current content). Skip it silently.
      } else {
        // New region being edited for the first time.
        regions.push({ original: op.oldString, current: op.newString })
      }
    }
  }

  // Filter out regions with no net change (original === current).
  const changed = regions.filter((r) => r.original !== r.current)

  if (changed.length === 0) {
    // If Write ops exist, the file was created/overwritten and regions were
    // reset with original===current. Show the final content as "all new".
    const hasWrite = ops.some((op) => op.isWrite)
    if (hasWrite && regions.length > 0) {
      const content = regions.map((r) => r.current).join("\n")
      if (content) {
        const counts = diffLineCount("", content)
        return { originalStr: "", currentStr: content, addCount: counts.add, delCount: counts.del }
      }
    }
    return { originalStr: "", currentStr: "", addCount: 0, delCount: 0 }
  }

  // Build before/after strings. LCS in EditDiffView will find common lines
  // (context) and highlight actual additions/removals.
  const originalStr = changed.map((r) => r.original).join("\n")
  const currentStr = changed.map((r) => r.current).join("\n")

  const counts = diffLineCount(originalStr, currentStr)

  return { originalStr, currentStr, addCount: counts.add, delCount: counts.del }
}
