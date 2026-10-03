import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Alias } from "vite"
import { root, TEAM_EDITION_UI_ENTRY, teamEditionIn } from "../scripts/lib/sourceFiles"

/** What `@cogpit/edition-ui` resolves to in a build without the edition's UI. */
export const EDITION_UI_STUB = "src/edition/absent.ts"

/**
 * The module `@cogpit/edition-ui` names in `checkout`: the team package's UI
 * entry when the package is there with one, and the build may use it
 * (COGPIT_WITHOUT_TEAM=1 builds as a public clone), else core's empty stub.
 */
export function editionUiEntry(checkout = root, env: NodeJS.ProcessEnv = process.env): string {
  const present = teamEditionIn(checkout)
    && existsSync(join(checkout, TEAM_EDITION_UI_ENTRY))
    && env.COGPIT_WITHOUT_TEAM !== "1"
  return join(checkout, present ? TEAM_EDITION_UI_ENTRY : EDITION_UI_STUB)
}

/**
 * The renderer's edition aliases: the UI entry, and `@cogpit/core/` for the
 * edition's own imports of core. The replacement is exactly the checkout root,
 * so a core module reached through it is the same module `@/` reaches.
 */
export function editionAliases(checkout = root, env: NodeJS.ProcessEnv = process.env): Alias[] {
  return [
    { find: /^@cogpit\/edition-ui$/, replacement: editionUiEntry(checkout, env) },
    { find: /^@cogpit\/core\//, replacement: `${checkout}/` },
  ]
}
