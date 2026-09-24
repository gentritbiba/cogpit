import type { CogpitEdition } from "../../shared/contracts/identity"
import { isRecord } from "../../shared/objects"
import { missingEditionMembers } from "./moduleShape"
import { getEdition, installEdition } from "./registry"
import { resolveEdition, type EditionShell } from "./resolve"
import type { EditionModule } from "./types"

/**
 * The team edition ships as a separate package. Held in a variable so no
 * bundler or type checker follows it: a build without the package is a
 * complete personal build, and only a team boot ever asks for it.
 */
const TEAM_PACKAGE = "@cogpit/team"

export type EditionImporter = () => Promise<unknown>

const importTeamPackage: EditionImporter = () => import(/* @vite-ignore */ TEAM_PACKAGE)

const QUOTED_TEAM_PACKAGE = [`'${TEAM_PACKAGE}'`, `"${TEAM_PACKAGE}"`]

/**
 * Whether the package itself could not be found, rather than something it
 * imports: Bun names the unresolved specifier on the error, Node only quotes it
 * in the message, where an installed package's own path is never quoted.
 */
function isTeamPackageMissing(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (typeof error.specifier === "string") return error.specifier === TEAM_PACKAGE
  const { message } = error
  return typeof message === "string" && QUOTED_TEAM_PACKAGE.some((quoted) => message.includes(quoted))
}

function teamEditionIn(loaded: unknown): EditionModule {
  const edition = isRecord(loaded) ? loaded.default : undefined
  if (!isRecord(edition) || edition.edition !== "team") throw new Error(`${TEAM_PACKAGE} does not export a team edition`)
  const missing = missingEditionMembers(edition)
  if (missing.length > 0) {
    throw new Error(`${TEAM_PACKAGE} does not match this build of Cogpit; it lacks ${missing.join(", ")}`)
  }
  return edition as unknown as EditionModule
}

async function importTeamEdition(importTeam: EditionImporter): Promise<EditionModule> {
  let loaded: unknown
  try {
    loaded = await importTeam()
  } catch (error) {
    if (isTeamPackageMissing(error)) {
      throw new Error(
        "Cogpit Team is not installed in this build — set COGPIT_EDITION=personal or remove edition from config.local.json",
        { cause: error },
      )
    }
    throw error
  }
  return teamEditionIn(loaded)
}

/**
 * Resolve the edition from the environment and config and install it. A team
 * resolution loads the team package, and a build without it refuses to boot.
 * Calling it again for the edition already running is a no-op, so the
 * standalone shell can resolve early and composition again later.
 */
export async function loadEdition(
  options: { shell: EditionShell; configEdition?: string },
  importTeam: EditionImporter = importTeamPackage,
): Promise<CogpitEdition> {
  const edition = resolveEdition(process.env, options.configEdition, options.shell)
  if (edition === getEdition()) return edition
  if (edition === "personal") {
    throw new Error(`Cogpit is already running its ${getEdition()} edition`)
  }
  installEdition(await importTeamEdition(importTeam))
  return edition
}
