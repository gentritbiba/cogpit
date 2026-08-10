import type { CogpitEdition } from "../../shared/contracts/team"

export type EditionShell = "electron" | "standalone" | "dev"

/**
 * Pure edition resolution. Team is only honored in the standalone shell;
 * electron/dev always run personal. A valid env value ("team"/"personal")
 * is authoritative over the config edition; invalid values fall through.
 */
export function resolveEdition(
  env: NodeJS.ProcessEnv,
  configEdition: string | undefined,
  shell: EditionShell,
): CogpitEdition {
  if (shell !== "standalone") return "personal"
  const envEdition = env.COGPIT_EDITION
  if (envEdition === "team" || envEdition === "personal") return envEdition
  return configEdition === "team" ? "team" : "personal"
}

/**
 * One-line boot diagnostic for a team request that resolveEdition did not
 * honor, so an operator never wonders why their team flag "did nothing".
 * Returns null when team was granted, when nothing asked for team, or when an
 * explicit valid COGPIT_EDITION=personal overrode the config (honored, not
 * suppressed).
 */
export function describeEditionSuppression(
  env: NodeJS.ProcessEnv,
  configEdition: string | undefined,
  shell: EditionShell,
): string | null {
  if (resolveEdition(env, configEdition, shell) === "team") return null
  const envEdition = env.COGPIT_EDITION
  if (envEdition && envEdition !== "team" && envEdition !== "personal") {
    return `COGPIT_EDITION="${envEdition}" is not recognized (use "team" or "personal") — running personal edition`
  }
  const teamRequested = envEdition === "team"
    || (configEdition === "team" && envEdition !== "personal")
  if (teamRequested && shell !== "standalone") {
    return `Team edition was requested but suppressed: the ${shell} shell always runs personal edition (only the standalone server supports team)`
  }
  return null
}

// Personal until initEdition runs — the safe no-op default.
let edition: CogpitEdition = "personal"

export function initEdition(opts: { shell: EditionShell; configEdition?: string }): void {
  edition = resolveEdition(process.env, opts.configEdition, opts.shell)
}

export function getEdition(): CogpitEdition {
  return edition
}

export function isTeamEdition(): boolean {
  return edition === "team"
}

export function __resetEditionForTest(): void {
  edition = "personal"
}
