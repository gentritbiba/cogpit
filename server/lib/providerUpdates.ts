/**
 * Version advisories for the agent CLIs Cogpit drives.
 *
 * Cogpit never vendors agent CLIs — it spawns whatever the user installed.
 * This module answers two questions about those installs: what
 * version is on this machine, and what version is published. When the two
 * disagree it also works out how the binary was installed, because that is
 * what decides whether `npm install -g`, `brew upgrade`, or `claude update`
 * is the command that would actually upgrade it.
 */
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"

import {
  type ProviderInstallMethod,
  type ProviderUpdateId,
  type ProviderUpdateInfo,
  type ProviderUpdateRunResult,
  type ProviderUpdateRunStatus,
  type ProviderUpdateStatus,
} from "../../shared/contracts/providerUpdates"
import { AGENT_KINDS } from "../../shared/providers/types"
import { compareVersions, extractVersion } from "../../shared/versions"
import { findExecutableOnPath, resolveAgentCommand } from "./binaryResolver"

const VERSION_PROBE_TIMEOUT_MS = 5_000
const REGISTRY_TIMEOUT_MS = 4_000
const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1_000
const PROBE_CACHE_TTL_MS = 60 * 1_000
const UPDATE_TIMEOUT_MS = 5 * 60_000
const UPDATE_OUTPUT_MAX_CHARS = 10_000

interface ProviderDefinition {
  id: ProviderUpdateId
  displayName: string
  binName: string
  packageName: string
  homebrew: { name: string; cask: boolean } | null
  wingetId: string | null
  /** Self-updater for installs that manage their own binary, if any. */
  native: { args: string[]; matches: (path: string) => boolean } | null
}

const PROVIDERS: Record<ProviderUpdateId, ProviderDefinition> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    binName: "claude",
    packageName: "@anthropic-ai/claude-code",
    homebrew: { name: "claude-code", cask: false },
    wingetId: null,
    native: {
      args: ["update"],
      matches: (path) =>
        path.endsWith("/.local/bin/claude") ||
        path.endsWith("/.local/bin/claude.exe") ||
        path.includes("/.local/share/claude/"),
    },
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    binName: "codex",
    packageName: "@openai/codex",
    homebrew: { name: "codex", cask: false },
    wingetId: null,
    native: null,
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    binName: "copilot",
    packageName: "@github/copilot",
    homebrew: { name: "copilot-cli", cask: true },
    wingetId: "GitHub.Copilot",
    native: {
      args: ["update"],
      matches: (path) =>
        path.endsWith("/.local/bin/copilot") ||
        path === "/usr/local/bin/copilot",
    },
  },
}

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
  const native = PROVIDERS[provider].native
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
  if (
    candidates.some((path) =>
      path.includes("/microsoft/winget/links/") ||
      path.includes("/microsoft/winget/packages/github.copilot"),
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
  if (native && candidates.some((path) => native.matches(path))) return "native"
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
  const definition = PROVIDERS[provider]
  switch (method) {
    case "native":
      return definition.native
        ? { executable: definition.binName, args: definition.native.args, lockKey: `${provider}-native` }
        : null
    case "bun":
      return {
        executable: "bun",
        args: ["i", "-g", `${definition.packageName}@latest`],
        lockKey: "bun-global",
      }
    case "pnpm":
      return {
        executable: "pnpm",
        args: ["add", "-g", `${definition.packageName}@latest`],
        lockKey: "pnpm-global",
      }
    case "homebrew":
      return definition.homebrew
        ? {
            executable: "brew",
            args: [
              "upgrade",
              ...(definition.homebrew.cask ? ["--cask"] : []),
              definition.homebrew.name,
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
          `--allow-scripts=${definition.packageName}`,
          `${definition.packageName}@latest`,
        ],
        lockKey: "npm-global",
      }
    case "winget":
      return definition.wingetId
        ? {
            executable: "winget",
            args: [
              "upgrade",
              "--id",
              definition.wingetId,
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

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const resolved = resolveAgentCommand(executable, args)
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...resolved.spawnOptions,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    // npm's progress output is unbounded; only the tail-end matters and the
    // response truncates anyway, so stop accumulating well before that.
    const append = (buffer: string, chunk: Buffer): string =>
      buffer.length >= UPDATE_OUTPUT_MAX_CHARS ? buffer : buffer + chunk.toString()

    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/** Resolve the binary on PATH plus its realpath, deduped. */
function resolveBinaryPaths(binName: string): string[] {
  const onPath = findExecutableOnPath(binName)
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

async function probeProvider(definition: ProviderDefinition): Promise<ProviderUpdateInfo> {
  const paths = resolveBinaryPaths(definition.binName)
  const base = {
    provider: definition.id,
    displayName: definition.displayName,
    packageName: definition.packageName,
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

  const [probe, latestVersion] = await Promise.all([
    runCommand(base.binaryPath, ["--version"], VERSION_PROBE_TIMEOUT_MS),
    fetchLatestVersion(definition.packageName),
  ])
  const currentVersion = extractVersion(`${probe.stdout}\n${probe.stderr}`)
  const installMethod = detectInstallMethod(definition.id, paths)
  const command = buildUpdateCommand(definition.id, installMethod)

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
 * Advisory for every provider. Cached briefly: an installed CLI's version
 * only changes when something installs one, and every connected client polls
 * this on mount.
 */
export function getProviderUpdates(): Promise<ProviderUpdateInfo[]> {
  return Promise.all(
    AGENT_KINDS.map((id) => probeCache.get(id, () => probeProvider(PROVIDERS[id]))),
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
  return trimmed.length <= UPDATE_OUTPUT_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, UPDATE_OUTPUT_MAX_CHARS)
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
  const definition = PROVIDERS[provider]
  const before = await probeCache.get(provider, () => probeProvider(definition))
  const result = (
    status: ProviderUpdateRunStatus,
    message: string,
    info: ProviderUpdateInfo,
    output: string | null = null,
  ): ProviderUpdateRunResult => ({ provider, status, message, output, info })

  if (!before.installed) {
    return result("failed", `${definition.displayName} is not installed on this machine.`, before)
  }
  const command = buildUpdateCommand(provider, before.installMethod)
  if (!command) {
    return result(
      "failed",
      `Cogpit cannot tell how ${definition.displayName} was installed, so it will not run an update for you.`,
      before,
    )
  }

  const run = await withUpdateLock(command.lockKey, () =>
    runCommand(command.executable, command.args, UPDATE_TIMEOUT_MS),
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
  const after = await probeCache.get(provider, () => probeProvider(definition))
  if (after.status === "behind" || after.currentVersion === before.currentVersion) {
    return result(
      "unchanged",
      `The update command finished, but ${definition.displayName} still reports ${after.currentVersion ?? "no version"}.`,
      after,
      output,
    )
  }
  return result(
    "succeeded",
    `${definition.displayName} updated to ${after.currentVersion ?? "a new version"}.`,
    after,
    output,
  )
}
