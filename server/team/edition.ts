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
