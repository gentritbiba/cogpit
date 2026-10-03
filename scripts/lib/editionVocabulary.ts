/**
 * Edition vocabulary: the ways core code could tell which edition it runs, or
 * talk to one edition's own API. Only `server/edition/` resolves and installs
 * an edition, so only those files may say which one is running; everything
 * else asks the `EditionModule` hooks or the renderer's UI slots, and no other
 * file may name the edition at all.
 */

/**
 * A line naming the edition: the team flag's call, an edition compared with
 * the team edition's name in either order, or a path under its API prefix.
 */
const EDITION_VOCABULARY: readonly RegExp[] = [
  /\bisTeamEdition\(/,
  /edition\w*(?:\(\))?\s*[!=]==?\s*(["'`])team\1/i,
  /(["'`])team\1\s*[!=]==?\s*[\w$.?]*edition/i,
  /\/api\/team\//,
]

/** The modules that resolve and install an edition, the neutral identity contract, and their tests. */
const EXEMPT = [
  "server/edition/registry.ts",
  "server/edition/resolve.ts",
  "server/edition/load.ts",
  "shared/contracts/identity.ts",
  "server/__tests__/edition/",
]

/** Whether a repo-relative path may name the edition freely. */
export function isEditionVocabularyExempt(path: string): boolean {
  return EXEMPT.some((exempt) => (exempt.endsWith("/") ? path.startsWith(exempt) : path === exempt))
}

/** Number of lines in `source` that name the edition. */
export function countEditionLines(source: string): number {
  return source.split("\n").filter((line) => EDITION_VOCABULARY.some((pattern) => pattern.test(line))).length
}

/** A violation for every file in `observed` (path to its count of edition-naming lines). */
export function editionVocabularyViolations(observed: ReadonlyMap<string, number>): string[] {
  return [...observed]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => `${path}: names the edition on ${count} line(s); ask server/edition/ or a UI slot instead`)
}
