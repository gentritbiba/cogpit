/**
 * Version advisories for the agent CLIs Cogpit drives.
 *
 * This module answers two questions about the binary Cogpit spawns for each
 * agent: what version is on this machine, and what version is published. When
 * the two disagree it also works out how the binary was installed, because that is
 * what decides whether `npm install -g`, `brew upgrade`, or `claude update`
 * is the command that would actually upgrade it.
 */
import { realpathSync } from "node:fs"

import {
  type ProviderInstallMethod,
  type ProviderUpdateId,
  type ProviderUpdateInfo,
  type ProviderUpdateRunResult,
  type ProviderUpdateRunStatus,
  type ProviderUpdateStatus,
} from "../../shared/contracts/providerUpdates"
import {
  AGENT_KINDS,
  descriptorFor,
  descriptorForDirName,
  type AgentDescriptor,
} from "../../shared/session/agent-descriptors"
import { compareVersions } from "../../shared/versions"
import { activeExecutableFor } from "../agents/executables"
import { findExecutableOnPath } from "./binaryResolver"
import { CLI_OUTPUT_MAX_CHARS, probeCliVersion, runCli } from "./cliProcess"

const REGISTRY_TIMEOUT_MS = 4_000
const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1_000
const PROBE_CACHE_TTL_MS = 60 * 1_000
const UPDATE_TIMEOUT_MS = 5 * 60_000

export function deriveStatus(
  current: string | null,
  latest: string | null,
): ProviderUpdateStatus {
  if (!current) return "not-installed"
  if (!latest) return "unknown"
  const comparison = compareVersions(current, latest)
  if (comparison === null) return "unknown"
  return comparison < 0 ? "behind" : "current"
}

// ── Install-method detection ─────────────────────────────────────────────

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase()
}

/**
 * Classify an install from where its binary lives. Callers pass every path
 * they know for the binary (the PATH hit and its realpath) because global npm
 * and Homebrew installs are usually symlinks into a versioned directory that
 * is the only thing identifying the manager.
 */
export function detectInstallMethod(
  provider: ProviderUpdateId,
  paths: readonly string[],
): ProviderInstallMethod {
  const { selfUpdate, wingetId } = descriptorFor(provider).cli
  const candidates = paths.filter(Boolean).map(normalizePath)
  if (candidates.length === 0) return "unknown"

  if (candidates.some((path) => path.includes("/.bun/bin/"))) return "bun"
  if (
    candidates.some((path) =>
      path.includes("/.local/share/pnpm/") ||
      path.includes("/library/pnpm/") ||
      path.includes("/appdata/local/pnpm/") ||
      path.includes("/pnpm/global/"),
    )
  ) {
    return "pnpm"
  }
  if (
    candidates.some((path) =>
      path.includes("/cellar/") ||
      path.includes("/caskroom/") ||
      path.startsWith("/opt/homebrew/bin/") ||
      path.startsWith("/home/linuxbrew/"),
    )
  ) {
    return "homebrew"
  }
  // The package directory carries the winget id; the links directory does not,
  // so a shim there is only attributable when nothing else claims the path.
  const wingetPackageDir = wingetId
    ? `/microsoft/winget/packages/${wingetId.toLowerCase()}`
    : null
  if (
    candidates.some((path) =>
      path.includes("/microsoft/winget/links/") ||
      (wingetPackageDir !== null && path.includes(wingetPackageDir)),
    )
  ) {
    return "winget"
  }
  if (
    candidates.some((path) =>
      path.includes("/node_modules/.bin/") ||
      path.includes("/lib/node_modules/") ||
      path.includes("/npm/node_modules/") ||
      path.includes("/npm-global/"),
    )
  ) {
    return "npm"
  }
  if (selfUpdate && candidates.some((path) => selfUpdate.matches(path))) return "native"
  return "unknown"
}

export interface UpdateCommand {
  executable: string
  args: string[]
  /** Serializes updates that share a package manager's global store. */
  lockKey: string
}

export function buildUpdateCommand(
  provider: ProviderUpdateId,
  method: ProviderInstallMethod,
): UpdateCommand | null {
  const { binName, cli } = descriptorFor(provider)
  switch (method) {
    case "native":
      return cli.selfUpdate
        ? { executable: binName, args: [...cli.selfUpdate.args], lockKey: `${provider}-native` }
        : null
    case "bun":
      return {
        executable: "bun",
        args: ["i", "-g", `${cli.packageName}@latest`],
        lockKey: "bun-global",
      }
    case "pnpm":
      return {
        executable: "pnpm",
        args: ["add", "-g", `${cli.packageName}@latest`],
        lockKey: "pnpm-global",
      }
    case "homebrew":
      return cli.homebrew
        ? {
            executable: "brew",
            args: [
              "upgrade",
              ...(cli.homebrew.cask ? ["--cask"] : []),
              cli.homebrew.name,
            ],
            lockKey: "homebrew",
          }
        : null
    case "npm":
      return {
        executable: "npm",
        // npm 12 blocks install scripts by default and still exits 0, so the
        // Claude postinstall that swaps its native binary in over a placeholder
        // stub silently never runs — a "successful" update leaves a broken CLI.
        args: [
          "install",
          "-g",
          `--allow-scripts=${cli.packageName}`,
          `${cli.packageName}@latest`,
        ],
        lockKey: "npm-global",
      }
    case "winget":
      return cli.wingetId
        ? {
            executable: "winget",
            args: [
              "upgrade",
              "--id",
              cli.wingetId,
              "--exact",
              "--accept-source-agreements",
              "--accept-package-agreements",
            ],
            lockKey: "winget",
          }
        : null
    default:
      return null
  }
}

export function formatCommand(command: UpdateCommand): string {
  return [command.executable, ...command.args].join(" ")
}

// ── Probes ───────────────────────────────────────────────────────────────

/**
 * The binary Cogpit spawns for this agent plus its realpath, deduped. Agents
 * without an executable choice resolve through PATH like any shell would.
 */
function resolveBinaryPaths(descriptor: AgentDescriptor): string[] {
  const onPath = activeExecutableFor(descriptor.kind) ?? findExecutableOnPath(descriptor.binName)
  if (!onPath) return []
  try {
    const real = realpathSync(onPath)
    return real === onPath ? [onPath] : [onPath, real]
  } catch {
    return [onPath]
  }
}

/**
 * Single-flight TTL cache. Concurrent callers share one result, so a browser
 * window per device cannot multiply into one process spawn each.
 */
function makeCache<K, V>(ttlMs: number) {
  const entries = new Map<K, { expiresAt: number; value: Promise<V> }>()
  return {
    get(key: K, load: () => Promise<V>): Promise<V> {
      const cached = entries.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.value
      const value = load().catch((error: unknown) => {
        entries.delete(key)
        throw error
      })
      entries.set(key, { expiresAt: Date.now() + ttlMs, value })
      return value
    },
    invalidate(key: K): void {
      entries.delete(key)
    },
    clear(): void {
      entries.clear()
    },
  }
}

const registryCache = makeCache<string, string | null>(REGISTRY_CACHE_TTL_MS)
const probeCache = makeCache<ProviderUpdateId, ProviderUpdateInfo>(PROBE_CACHE_TTL_MS)

/** Latest published version, or null when the registry is unreachable. */
export function fetchLatestVersion(packageName: string): Promise<string | null> {
  return registryCache.get(packageName, async () => {
    try {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        },
      )
      if (!response.ok) return null
      const payload = (await response.json()) as { version?: unknown }
      return typeof payload.version === "string" && payload.version.trim()
        ? payload.version.trim()
        : null
    } catch {
      return null
    }
  })
}

/** @internal test-only */
export function _resetProviderUpdateCachesForTests(): void {
  registryCache.clear()
  probeCache.clear()
  updateLocks.clear()
}

async function probeProvider(descriptor: AgentDescriptor): Promise<ProviderUpdateInfo> {
  const paths = resolveBinaryPaths(descriptor)
  const base = {
    provider: descriptor.kind,
    displayName: descriptor.displayName,
    packageName: descriptor.cli.packageName,
    binaryPath: paths[0] ?? null,
    checkedAt: new Date().toISOString(),
  }

  if (!base.binaryPath) {
    return {
      ...base,
      installed: false,
      currentVersion: null,
      latestVersion: null,
      status: "not-installed",
      installMethod: "unknown",
      updateCommand: null,
    }
  }

  const [currentVersion, latestVersion] = await Promise.all([
    probeCliVersion(base.binaryPath, descriptor.cli.versionArgs),
    fetchLatestVersion(descriptor.cli.packageName),
  ])
  const installMethod = detectInstallMethod(descriptor.kind, paths)
  const command = buildUpdateCommand(descriptor.kind, installMethod)

  return {
    ...base,
    installed: true,
    currentVersion,
    latestVersion,
    status: deriveStatus(currentVersion, latestVersion),
    installMethod,
    updateCommand: command && formatCommand(command),
  }
}

/**
 * Order the banner renders these in. Registry order puts the agent that owns
 * every unprefixed project last, and it is the one an install always has, so it
 * leads here instead.
 */
const DEFAULT_PROVIDER = descriptorForDirName(null).kind
const REPORT_ORDER: readonly ProviderUpdateId[] = [
  DEFAULT_PROVIDER,
  ...AGENT_KINDS.filter((kind) => kind !== DEFAULT_PROVIDER),
]

/**
 * Advisory for every provider. Cached briefly: an installed CLI's version
 * only changes when something installs one, and every connected client polls
 * this on mount.
 */
export function getProviderUpdates(): Promise<ProviderUpdateInfo[]> {
  return Promise.all(
    REPORT_ORDER.map((id) => probeCache.get(id, () => probeProvider(descriptorFor(id)))),
  )
}

export function isProviderUpdateId(value: unknown): value is ProviderUpdateId {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value)
}

// ── Running an update ────────────────────────────────────────────────────

/** In-flight update per package-manager store, so two global installs queue. */
const updateLocks = new Map<string, Promise<unknown>>()

function truncate(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  return trimmed.length <= CLI_OUTPUT_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, CLI_OUTPUT_MAX_CHARS)
}

async function withUpdateLock<T>(lockKey: string, run: () => Promise<T>): Promise<T> {
  const previous = updateLocks.get(lockKey) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(run)
  updateLocks.set(lockKey, next)
  try {
    return await next
  } finally {
    if (updateLocks.get(lockKey) === next) updateLocks.delete(lockKey)
  }
}

export async function runProviderUpdate(
  provider: ProviderUpdateId,
): Promise<ProviderUpdateRunResult> {
  const descriptor = descriptorFor(provider)
  const before = await probeCache.get(provider, () => probeProvider(descriptor))
  const result = (
    status: ProviderUpdateRunStatus,
    message: string,
    info: ProviderUpdateInfo,
    output: string | null = null,
  ): ProviderUpdateRunResult => ({ provider, status, message, output, info })

  if (!before.installed) {
    return result("failed", `${descriptor.displayName} is not installed on this machine.`, before)
  }
  const command = buildUpdateCommand(provider, before.installMethod)
  if (!command) {
    return result(
      "failed",
      `Cogpit cannot tell how ${descriptor.displayName} was installed, so it will not run an update for you.`,
      before,
    )
  }

  const run = await withUpdateLock(command.lockKey, () =>
    runCli(command.executable, command.args, UPDATE_TIMEOUT_MS),
  )
  const output = truncate(`${run.stderr}\n${run.stdout}`)

  if (run.timedOut || run.code !== 0) {
    return result(
      "failed",
      run.timedOut
        ? "Update timed out after 5 minutes."
        : `\`${formatCommand(command)}\` exited with code ${run.code ?? "unknown"}.`,
      before,
      output,
    )
  }

  // The registry answer is still valid; the installed version is what changed.
  probeCache.invalidate(provider)
  const after = await probeCache.get(provider, () => probeProvider(descriptor))
  if (after.status === "behind" || after.currentVersion === before.currentVersion) {
    return result(
      "unchanged",
      `The update command finished, but ${descriptor.displayName} still reports ${after.currentVersion ?? "no version"}.`,
      after,
      output,
    )
  }
  return result(
    "succeeded",
    `${descriptor.displayName} updated to ${after.currentVersion ?? "a new version"}.`,
    after,
    output,
  )
}
