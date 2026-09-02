/**
 * Contract for CLI provider update advisories.
 *
 * Cogpit drives agent CLIs that the user installed themselves, so it can only
 * report on them, not vendor them. The server
 * probes the installed binary, compares it against the npm registry's
 * `latest`, and — when it can tell how the binary was installed — hands back
 * the exact command that would upgrade it.
 */
import type { AgentKind } from "../session/types"

export type ProviderUpdateId = AgentKind

/**
 * How the binary got onto this machine, which decides the upgrade command.
 * `unknown` means the path matched no known layout — Cogpit reports the
 * version but refuses to guess a command that could clobber the install.
 */
export type ProviderInstallMethod =
  | "npm"
  | "bun"
  | "pnpm"
  | "homebrew"
  | "winget"
  | "native"
  | "unknown"

export type ProviderUpdateStatus =
  /** Installed version is at or ahead of the registry's latest. */
  | "current"
  /** A newer version is published. */
  | "behind"
  /** The CLI is not on PATH. */
  | "not-installed"
  /** Probe or registry lookup failed; never surfaced as an update prompt. */
  | "unknown"

export interface ProviderUpdateInfo {
  provider: ProviderUpdateId
  displayName: string
  /** npm package the version check reads, for display and support. */
  packageName: string
  installed: boolean
  binaryPath: string | null
  currentVersion: string | null
  latestVersion: string | null
  status: ProviderUpdateStatus
  installMethod: ProviderInstallMethod
  /**
   * Command that would upgrade this install, or null when Cogpit could not
   * tell how it was installed. Non-null is exactly "Cogpit can run this".
   */
  updateCommand: string | null
  /** ISO timestamp of this probe. */
  checkedAt: string
}

export interface ProviderUpdatesResponse {
  providers: ProviderUpdateInfo[]
}

export type ProviderUpdateRunStatus = "succeeded" | "unchanged" | "failed"

export interface ProviderUpdateRunResult {
  provider: ProviderUpdateId
  status: ProviderUpdateRunStatus
  message: string
  /** Trimmed stdout/stderr from the update command, for the failure path. */
  output: string | null
  /** Advisory re-probed after the command ran. */
  info: ProviderUpdateInfo
}

/**
 * Stable key for "this exact upgrade offer", so dismissing 2.1.19 still
 * prompts when 2.1.20 lands.
 */
export function providerUpdateDismissKey(info: ProviderUpdateInfo): string {
  return `${info.provider}:${info.latestVersion ?? "unknown"}`
}

/**
 * Replace any dismissal already recorded for this provider — only the newest
 * offer can match again, so older keys are dead weight.
 */
export function nextDismissals(keys: readonly string[], key: string): string[] {
  const provider = key.split(":")[0]
  return [...keys.filter((existing) => existing.split(":")[0] !== provider), key]
}
