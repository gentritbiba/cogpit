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

  // LCS on the trimmed middle only
  const dp: number[][] = Array.from({ length: om + 1 }, () => Array(on + 1).fill(0))
  for (let i = 1; i <= om; i++) {
    for (let j = 1; j <= on; j++) {
      dp[i][j] =
        oldLines[prefix + i - 1] === newLines[prefix + j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Count added/removed by backtracking
  let add = 0
  let del = 0
  let i = om
  let j = on
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      add++; j--
    } else {
      del++; i--
    }
  }

  return { add, del }
}
