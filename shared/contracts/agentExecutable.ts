/**
 * Which binary Cogpit spawns for an agent CLI, when more than one is on the
 * machine. Today only one agent has more than one plausible binary — the
 * Agent SDK vendors its own copy of that CLI — so this contract is agent-neutral
 * but served for a single kind.
 */

export type ExecutableSource =
  /** Cogpit picks: the install on PATH unless it is older than the bundled copy. */
  | "auto"
  /** The binary found on PATH, launchable directly. */
  | "path"
  /** The global npm install, followed through its shim to the real binary. */
  | "npm"
  /** The copy shipped inside Cogpit's Agent SDK dependency. */
  | "bundled"
  /** A path the user typed. */
  | "custom"

export const EXECUTABLE_SOURCES: readonly ExecutableSource[] = [
  "auto",
  "path",
  "npm",
  "bundled",
  "custom",
]

export interface ExecutableChoice {
  source: ExecutableSource
  /** Only meaningful for `custom`. */
  path?: string
}

export const DEFAULT_EXECUTABLE_CHOICE: ExecutableChoice = { source: "auto" }

export type DetectedExecutableSource = Exclude<ExecutableSource, "auto" | "custom">

/** The sources Cogpit probes for, in the order they are offered and preferred. */
export const DETECTED_EXECUTABLE_SOURCES: readonly DetectedExecutableSource[] = [
  "path",
  "npm",
  "bundled",
]

export interface ExecutableCandidate {
  source: DetectedExecutableSource
  path: string
  version: string | null
}

export interface ActiveExecutable {
  /** The concrete source `auto` resolved to, or the chosen one. */
  source: DetectedExecutableSource | "custom"
  path: string
  version: string | null
}

export interface ExecutableReport {
  choice: ExecutableChoice
  candidates: ExecutableCandidate[]
  /** Null when nothing launchable exists for the choice. */
  active: ActiveExecutable | null
}

function isExecutableSource(value: unknown): value is ExecutableSource {
  return EXECUTABLE_SOURCES.includes(value as ExecutableSource)
}

/** Narrow a persisted or posted value; anything malformed means "auto". */
export function parseExecutableChoice(value: unknown): ExecutableChoice | undefined {
  if (!value || typeof value !== "object") return undefined
  const { source, path } = value as { source?: unknown; path?: unknown }
  if (!isExecutableSource(source) || source === "auto") return undefined
  if (source === "custom") {
    return typeof path === "string" && path.trim() ? { source, path: path.trim() } : undefined
  }
  return { source }
}
