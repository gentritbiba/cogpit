/**
 * On-disk transcript discovery, one walker per agent CLI.
 *
 * The *knowledge* — where a root lives, how a session file is named, which
 * session a path belongs to — comes from the synced `agent-descriptors` table,
 * the same one the app reads. Only the `node:fs` walking lives here, because
 * `shared/` is bundled into a browser and cannot contain node builtins, so this
 * much genuinely has to exist twice.
 *
 * Every listing path in the package goes through this module. Before it there
 * were three hand-written Copilot walkers, two Codex walkers and three Claude
 * walkers, and the FTS index quietly covered a different set of agents from the
 * raw scan — which is why Codex sessions were unsearchable.
 *
 * The walks are synchronous. They are bounded local `readdir`/`stat` calls in a
 * short-lived CLI process, and a single pass costs less than the promise
 * bookkeeping the parallel versions needed — while letting the FTS index, whose
 * build is one synchronous SQLite transaction, share exactly this code.
 */
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  AGENT_KINDS,
  descriptorFor,
  type AgentDescriptor,
  type AgentKind,
} from "./agent-descriptors"
import { dirs } from "./dirs"

/** One transcript on disk, plus what an index needs to file it under. */
export interface SessionFile {
  path: string
  mtimeMs: number
  sessionId: string
  isSubagent: boolean
  parentSessionId: string | null
}

/** Where a transcript belongs, without reading it. */
export type SessionFileIdentity = Omit<SessionFile, "path" | "mtimeMs">

export interface AgentSessionStore {
  readonly kind: AgentKind
  readonly descriptor: AgentDescriptor
  /** Absolute root this agent's transcripts live under. */
  root(): string
  /** True when an absolute path is inside this agent's root. */
  ownsPath(filePath: string): boolean
  /**
   * Which session a transcript belongs to. Never `basename(file, ".jsonl")`:
   * that is Copilot's literal `events`, and it loses a sub-agent's parent.
   */
  identify(filePath: string, root?: string): SessionFileIdentity
  /** Transcripts modified at or after `cutoffMs`. */
  list(cutoffMs: number, root?: string): SessionFile[]
  /** Locate a session by id, or null when this agent does not have it. */
  find(sessionId: string): string | null
}

/** Cogpit's own notes live beside the projects; they are not transcripts. */
const NON_PROJECT_DIRS = new Set(["memory"])

/** The dated tree a rollout is nested in; nothing legitimate sits deeper. */
const MAX_WALK_DEPTH = 4

const SUBAGENTS_DIR = "subagents"

function mtimeOf(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

function readDirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** True when `target` sits strictly inside `root`. */
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Canonical path of `filePath`, but only while the symlinks it follows keep it
 * inside `root`. A session directory pointing somewhere else is not that
 * agent's session, and reading it would hand a caller an arbitrary file.
 */
function canonicalWithinRoot(root: string, filePath: string): string | null {
  try {
    const realRoot = realpathSync(root)
    const real = realpathSync(filePath)
    return isWithin(realRoot, real) ? real : null
  } catch {
    return null
  }
}

/** Path segments of `filePath` relative to `root`, separator-agnostic. */
function segmentsUnder(root: string, filePath: string): string[] {
  return relative(root, filePath).split(sep).filter(Boolean)
}

// ── Claude: <root>/<project>/<sessionId>.jsonl, plus subagents/ ──────────────

function claudeIdentify(filePath: string, root: string): SessionFileIdentity {
  const segments = segmentsUnder(root, filePath)
  const subagentAt = segments.lastIndexOf(SUBAGENTS_DIR)
  if (subagentAt > 0) {
    // `<project>/<sessionId>/subagents/agent-<id>.jsonl`: the directory above
    // the marker names the parent session.
    const parentSessionId = segments[subagentAt - 1]
    return { sessionId: parentSessionId, isSubagent: true, parentSessionId }
  }
  const fileName = segments[segments.length - 1] ?? ""
  return {
    sessionId: descriptorFor("claude").sessionFile.sessionId(fileName)
      ?? fileName.replace(/\.jsonl$/, ""),
    isSubagent: false,
    parentSessionId: null,
  }
}

/** `<parent>.jsonl` -> `<parent>/subagents`, recursively. */
function subagentDirOf(parentPath: string): string {
  return join(parentPath.replace(/\.jsonl$/, ""), SUBAGENTS_DIR)
}

function walkClaudeSubagents(
  parentPath: string,
  parentSessionId: string,
  cutoffMs: number,
  depth: number,
  out: SessionFile[],
): void {
  if (depth >= MAX_WALK_DEPTH) return
  const dir = subagentDirOf(parentPath)
  for (const entry of readDirSafe(dir)) {
    if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) continue
    const filePath = join(dir, entry.name)
    const mtimeMs = mtimeOf(filePath)
    if (mtimeMs !== null && mtimeMs >= cutoffMs) {
      out.push({
        path: filePath,
        mtimeMs,
        sessionId: parentSessionId,
        isSubagent: true,
        parentSessionId,
      })
    }
    walkClaudeSubagents(filePath, parentSessionId, cutoffMs, depth + 1, out)
  }
}

function walkClaude(root: string, cutoffMs: number): SessionFile[] {
  const found: SessionFile[] = []
  for (const project of readDirSafe(root)) {
    if (!project.isDirectory() || NON_PROJECT_DIRS.has(project.name)) continue
    const projectDir = join(root, project.name)
    for (const entry of readDirSafe(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const filePath = join(projectDir, entry.name)
      const mtimeMs = mtimeOf(filePath)
      const { sessionId } = claudeIdentify(filePath, root)
      if (mtimeMs !== null && mtimeMs >= cutoffMs) {
        found.push({ path: filePath, mtimeMs, sessionId, isSubagent: false, parentSessionId: null })
      }
      // Sub-agent transcripts are listed even when the parent aged out: they
      // carry their own content and their own mtime.
      walkClaudeSubagents(filePath, sessionId, cutoffMs, 0, found)
    }
  }
  return found
}

// ── Codex: <root>/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl ──────────────────

function walkCodex(root: string, cutoffMs: number, dir = root, depth = 0): SessionFile[] {
  if (depth > MAX_WALK_DEPTH) return []
  const found: SessionFile[] = []
  for (const entry of readDirSafe(dir)) {
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walkCodex(root, cutoffMs, filePath, depth + 1))
      continue
    }
    if (!entry.name.endsWith(".jsonl")) continue
    const mtimeMs = mtimeOf(filePath)
    if (mtimeMs === null || mtimeMs < cutoffMs) continue
    found.push({
      path: filePath,
      mtimeMs,
      sessionId: descriptorFor("codex").sessionFile.sessionId(entry.name) ?? "",
      isSubagent: false,
      parentSessionId: null,
    })
  }
  return found
}

// ── Copilot: <root>/<sessionId>/events.jsonl ─────────────────────────────────

function copilotTranscript(root: string, sessionId: string): string {
  return join(root, descriptorFor("copilot").sessionFile.name(sessionId))
}

function walkCopilot(root: string, cutoffMs: number): SessionFile[] {
  const found: SessionFile[] = []
  for (const entry of readDirSafe(root)) {
    if (!entry.isDirectory()) continue
    const filePath = copilotTranscript(root, entry.name)
    const mtimeMs = mtimeOf(filePath)
    if (mtimeMs === null || mtimeMs < cutoffMs) continue
    found.push({
      path: filePath,
      mtimeMs,
      sessionId: entry.name,
      isSubagent: false,
      parentSessionId: null,
    })
  }
  return found
}

// ── The table ────────────────────────────────────────────────────────────────

interface Walker {
  root(): string
  list(root: string, cutoffMs: number): SessionFile[]
  identify(filePath: string, root: string): SessionFileIdentity
  find(root: string, sessionId: string): string | null
}

const WALKERS: Record<AgentKind, Walker> = {
  claude: {
    root: () => dirs.PROJECTS_DIR,
    list: walkClaude,
    identify: claudeIdentify,
    find(root, sessionId) {
      const fileName = descriptorFor("claude").sessionFile.name(sessionId)
      for (const project of readDirSafe(root)) {
        if (!project.isDirectory() || NON_PROJECT_DIRS.has(project.name)) continue
        const candidate = join(root, project.name, fileName)
        if (mtimeOf(candidate) !== null) return candidate
      }
      return null
    },
  },

  codex: {
    root: () => dirs.CODEX_SESSIONS_DIR,
    list: (root, cutoffMs) => walkCodex(root, cutoffMs),
    identify: (filePath) => ({
      sessionId: descriptorFor("codex").sessionFile.sessionId(filePath) ?? "",
      isSubagent: false,
      parentSessionId: null,
    }),
    // A rollout's date nesting cannot be rebuilt from the id, so the tree is
    // walked; every rollout carries the id in its file name.
    find(root, sessionId) {
      const walk = (dir: string, depth: number): string | null => {
        if (depth > MAX_WALK_DEPTH) return null
        for (const entry of readDirSafe(dir)) {
          const filePath = join(dir, entry.name)
          if (entry.isDirectory()) {
            const match = walk(filePath, depth + 1)
            if (match) return match
            continue
          }
          if (entry.name.endsWith(`${sessionId}.jsonl`)) return filePath
        }
        return null
      }
      return walk(root, 0)
    },
  },

  copilot: {
    root: () => dirs.COPILOT_SESSIONS_DIR,
    list: walkCopilot,
    identify: (filePath, root) => ({
      sessionId: segmentsUnder(root, filePath)[0] ?? "",
      isSubagent: false,
      parentSessionId: null,
    }),
    find(root, sessionId) {
      const candidate = copilotTranscript(root, sessionId)
      return mtimeOf(candidate) === null ? null : candidate
    },
  },
}

function makeStore(kind: AgentKind): AgentSessionStore {
  const walker = WALKERS[kind]
  return {
    kind,
    descriptor: descriptorFor(kind),
    root: walker.root,
    ownsPath: (filePath) => isWithin(resolve(walker.root()), resolve(filePath)),
    identify: (filePath, root = walker.root()) => walker.identify(filePath, root),
    list: (cutoffMs, root = walker.root()) => walker.list(root, cutoffMs),
    find: (sessionId) => walker.find(walker.root(), sessionId),
  }
}

const STORES: Record<AgentKind, AgentSessionStore> = {
  claude: makeStore("claude"),
  codex: makeStore("codex"),
  copilot: makeStore("copilot"),
}

export function storeFor(kind: AgentKind): AgentSessionStore {
  return STORES[kind]
}

/** Every store, in registry order. */
export function allStores(): readonly AgentSessionStore[] {
  return AGENT_KINDS.map((kind) => STORES[kind])
}

/** The store whose root contains `filePath`, or null when none does. */
export function storeForPath(filePath: string): AgentSessionStore | null {
  return allStores().find((store) => store.ownsPath(filePath)) ?? null
}

/** The store whose root is exactly `root`, for a caller that names one. */
export function storeForRoot(root: string): AgentSessionStore | null {
  const target = resolve(root)
  return allStores().find((store) => resolve(store.root()) === target) ?? null
}

/**
 * Transcripts from every agent, newest first. One walk per root, so no caller
 * can accidentally cover a different set of agents from its neighbours.
 */
export function listAllSessionFiles(cutoffMs: number): SessionFile[] {
  return allStores()
    .flatMap((store) => store.list(cutoffMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * A single, non-traversing path component. Anything carrying a separator, a
 * NUL or a `..` is refused before it can be joined onto a root.
 */
export function isSinglePathSegment(value: string): boolean {
  return value.length > 0
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value !== "."
    && value !== ".."
}

/**
 * Absolute path of a session's transcript, searched across every agent.
 *
 * The id arrives from a CLI argument and is joined straight onto a root, so it
 * is rejected outright unless it is a single path segment.
 */
export async function findSessionFile(sessionId: string): Promise<string | null> {
  if (!isSinglePathSegment(sessionId)) return null
  for (const store of allStores()) {
    const filePath = store.find(sessionId)
    const canonical = filePath && canonicalWithinRoot(store.root(), filePath)
    if (canonical) return canonical
  }
  return null
}
