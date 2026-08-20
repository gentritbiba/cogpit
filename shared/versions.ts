/**
 * Semver parsing and comparison for CLI version strings.
 *
 * Agent CLIs report versions in noisy banners (`2.1.238 (Claude Code)`,
 * `codex-cli 0.149.0`) and npm reports clean ones, so extraction and
 * comparison are separate steps.
 */

interface ParsedVersion {
  parts: number[]
  prerelease: string[]
}

/** `v2.1.220-beta.1` -> `{ parts: [2,1,220], prerelease: ["beta","1"] }`. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = raw.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

/** Pull the first semver-looking token out of `--version` output. */
export function extractVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match ? match[0] : null
}

function comparePrerelease(a: string[], b: string[]): number {
  // A release outranks any prerelease of the same numbers (semver §11.3).
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** -1 / 0 / 1, or null when either side is unparseable. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}
