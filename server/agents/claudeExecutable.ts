/**
 * Which Claude Code binary Cogpit spawns.
 *
 * Two copies can exist on one machine: the CLI the user installed, and the one
 * the Agent SDK vendors in its platform package. Development and server installs
 * can fall back to the vendored copy; the packaged Electron app omits it and
 * requires an installed CLI. `auto` prefers the install whenever it is at least
 * as new as the vendored copy, and only accepts installs the OS can launch
 * directly — an npm `claude.cmd` shim is not one, so npm-on-Windows users pick
 * the `npm` source to follow the shim to the native binary it wraps.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { posix, win32 } from "node:path"

import type {
  ActiveExecutable,
  DetectedExecutableSource,
  ExecutableChoice,
  ExecutableReport,
} from "../../shared/contracts/agentExecutable"
import {
  DEFAULT_EXECUTABLE_CHOICE,
  DETECTED_EXECUTABLE_SOURCES,
} from "../../shared/contracts/agentExecutable"
import { getConfig } from "../config"
import { findExecutableOnPath, isDirectlyLaunchable, nativeBinaryName } from "../lib/binaryResolver"
import { probeCliVersion } from "../lib/cliProcess"

const BIN_NAME = "claude"
const NPM_PACKAGE = "@anthropic-ai/claude-code"
const CLI_BIN_NAME = nativeBinaryName(BIN_NAME)

/** Separator-agnostic so the packaged Windows app is detected too. */
const ASAR_SEGMENT = /([\\/])app\.asar([\\/])/

export interface ClaudeExecutables {
  /** Directly launchable `claude` on PATH. */
  installed: string | undefined
  /** Native binary behind the global npm install, when one exists. */
  npm: string | undefined
  /** The Agent SDK's vendored copy, when the platform package is present. */
  bundled: string | undefined
}

export interface ResolvedClaudeExecutable {
  source: ActiveExecutable["source"]
  path: string
}

// ── npm shim ────────────────────────────────────────────────────────────

export interface NpmProbeEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  isFile?: (path: string) => boolean
  readFile?: (path: string) => string | undefined
}

function realIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function realReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return undefined
  }
}

/** The package manifest's `bin` entry for this CLI, as a relative path. */
function binField(manifest: string): string | undefined {
  let bin: unknown
  try {
    bin = (JSON.parse(manifest) as { bin?: unknown }).bin
  } catch {
    return undefined
  }
  if (typeof bin === "string") return bin
  if (!bin || typeof bin !== "object") return undefined
  const entry = (bin as Record<string, unknown>)[BIN_NAME]
  return typeof entry === "string" ? entry : undefined
}

/**
 * The native binary a global npm install of Claude Code wraps. npm puts the
 * `claude` shim next to `node_modules` on Windows and one level above
 * `lib/node_modules` elsewhere; the package's own `bin` field says where the
 * real entry point is.
 */
export function findNpmClaude(options: NpmProbeEnvironment = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  const isFile = options.isFile ?? realIsFile
  const readFile = options.readFile ?? realReadFile

  const shim = findExecutableOnPath(BIN_NAME, { platform, env: options.env, isExecutable: isFile })
  if (!shim) return undefined
  const shimDir = path.dirname(shim)
  const packageDirs = [
    path.join(shimDir, "node_modules", NPM_PACKAGE),
    path.join(shimDir, "..", "lib", "node_modules", NPM_PACKAGE),
  ]

  for (const packageDir of packageDirs) {
    const manifest = readFile(path.join(packageDir, "package.json"))
    if (!manifest) continue
    const relative = binField(manifest)
    if (!relative) continue
    const target = path.normalize(path.join(packageDir, relative))
    if (windows && !isDirectlyLaunchable(target)) continue
    if (isFile(target)) return target
  }
  return undefined
}

// ── Discovery ───────────────────────────────────────────────────────────

export interface DiscoveryProbes {
  findOnPath?: () => string | undefined
  findNpm?: () => string | undefined
}

/** First directly launchable `claude` on PATH, if any. */
function findInstalledClaude(): string | undefined {
  return findExecutableOnPath(BIN_NAME, { directOnly: true })
}

function findBundledClaude(resolveModule: (id: string) => string): string | undefined {
  try {
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    // Swapping the file name keeps the resolver's own separators, which the
    // asar rewrite relies on.
    return resolveModule(`${platformPkg}/package.json`)
      .replace(/package\.json$/, CLI_BIN_NAME)
      .replace(ASAR_SEGMENT, "$1app.asar.unpacked$2")
  } catch {
    return undefined
  }
}

export function discoverClaudeExecutables(
  resolveModule: (id: string) => string,
  probes: DiscoveryProbes = {},
): ClaudeExecutables {
  return {
    installed: (probes.findOnPath ?? findInstalledClaude)(),
    npm: (probes.findNpm ?? findNpmClaude)(),
    bundled: findBundledClaude(resolveModule),
  }
}

// ── Choice ──────────────────────────────────────────────────────────────

export type VersionReader = (binPath: string) => number[] | undefined

/** `2.1.220 (Claude Code)` -> `[2, 1, 220]`; undefined if the binary won't answer. */
function readCliVersionSync(binPath: string): number[] | undefined {
  try {
    const output = execFileSync(binPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
  } catch {
    return undefined
  }
}

function isAtLeast(version: number[], floor: number[]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== floor[i]) return version[i] > floor[i]
  }
  return true
}

function chooseAutomatically(
  found: ClaudeExecutables,
  readVersion: VersionReader,
): ResolvedClaudeExecutable | undefined {
  const bundled = found.bundled ? { source: "bundled" as const, path: found.bundled } : undefined
  if (!found.installed) return bundled
  const installed = { source: "path" as const, path: found.installed }

  const installedVersion = readVersion(found.installed)
  // Without a version there is nothing to compare, so only reach for the
  // bundled copy when one exists; otherwise the installed CLI is all there is.
  if (!installedVersion) return bundled ?? installed

  // Never downgrade: a CLI older than the one the SDK was built against can
  // break the control protocol, not just the model list.
  const bundledVersion = bundled ? readVersion(bundled.path) : undefined
  if (bundledVersion && !isAtLeast(installedVersion, bundledVersion)) return bundled
  return installed
}

export function chooseClaudeExecutable(
  choice: ExecutableChoice,
  found: ClaudeExecutables,
  readVersion: VersionReader,
): ResolvedClaudeExecutable | undefined {
  switch (choice.source) {
    case "auto":
      return chooseAutomatically(found, readVersion)
    case "custom":
      return choice.path ? { source: "custom", path: choice.path } : undefined
    case "path":
      return found.installed ? { source: "path", path: found.installed } : undefined
    case "npm":
      return found.npm ? { source: "npm", path: found.npm } : undefined
    case "bundled":
      return found.bundled ? { source: "bundled", path: found.bundled } : undefined
  }
}

// ── Live resolution ─────────────────────────────────────────────────────

const resolveModule = (id: string) => createRequire(import.meta.url).resolve(id)

function configuredChoice(): ExecutableChoice {
  return getConfig()?.agentExecutable ?? DEFAULT_EXECUTABLE_CHOICE
}

let memo: { key: string; resolved: ResolvedClaudeExecutable | undefined } | undefined

/**
 * The Claude CLI the configured choice resolves to right now. Memoized per
 * choice — resolution shells out to `claude --version` — and recomputed the
 * moment the setting changes.
 */
export function resolveClaudeExecutable(): ResolvedClaudeExecutable | undefined {
  const choice = configuredChoice()
  const key = JSON.stringify(choice)
  if (memo?.key !== key) {
    memo = {
      key,
      resolved: chooseClaudeExecutable(choice, discoverClaudeExecutables(resolveModule), readCliVersionSync),
    }
  }
  return memo.resolved
}

/**
 * Path to spawn, or undefined to let the SDK resolve its own binary — which
 * only happens when nothing at all could be found.
 */
export function claudeCliPath(): string | undefined {
  return resolveClaudeExecutable()?.path
}

/** Everything the executable picker needs: each detected binary, its version, and what is live. */
export async function describeClaudeExecutable(): Promise<ExecutableReport> {
  const choice = configuredChoice()
  const found = discoverClaudeExecutables(resolveModule)
  const active = resolveClaudeExecutable()

  const pathBySource: Record<DetectedExecutableSource, string | undefined> = {
    path: found.installed,
    npm: found.npm,
    bundled: found.bundled,
  }
  const detected = DETECTED_EXECUTABLE_SOURCES
    .filter((source) => pathBySource[source] !== undefined)
    .map((source) => ({ source, path: pathBySource[source]! }))

  const paths = new Set([...detected.map(({ path }) => path), ...(active ? [active.path] : [])])
  const versions = new Map(
    await Promise.all(
      [...paths].map(async (path) => [path, await probeCliVersion(path, ["--version"])] as const),
    ),
  )

  return {
    choice,
    candidates: detected.map((candidate) => ({
      ...candidate,
      version: versions.get(candidate.path) ?? null,
    })),
    active: active ? { ...active, version: versions.get(active.path) ?? null } : null,
  }
}
