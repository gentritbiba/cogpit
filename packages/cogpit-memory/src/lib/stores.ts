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
import { readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  AGENT_KINDS,
  descriptorFor,
  type AgentDescriptor,
  type AgentKind,
  descriptorForDirName,
} from "./agent-descriptors"
import { dirs } from "./dirs"
import { instanceSessionId, splitInstanceSessionId } from "./instances"
import { isListableTranscript, uncompressedTranscriptName } from "./transcriptFile"

/** One transcript on disk, plus what an index needs to file it under. */
export interface SessionFile {
  path: string
  mtimeMs: number
  size: number
  sessionId: string
  isSubagent: boolean
  parentSessionId: string | null
  /** The subagent a sub-agent transcript belongs to; null for a session's own transcript. */
  agentId: string | null
}

/** Where a transcript belongs, without reading it. */
export type SessionFileIdentity = Omit<SessionFile, "path" | "mtimeMs" | "size">

export interface AgentSessionStore {
  readonly kind: AgentKind
  readonly instanceId: string
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

function statOf(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const { mtimeMs, size } = statSync(filePath)
    return { mtimeMs, size }
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
    return { sessionId: parentSessionId, isSubagent: true, parentSessionId, agentId: subagentIdOf(segments[segments.length - 1] ?? "") }
  }
  const fileName = segments[segments.length - 1] ?? ""
  return {
    sessionId: descriptorFor("claude").sessionFile.sessionId(fileName)
      ?? fileName.replace(/\.jsonl$/, ""),
    isSubagent: false,
    parentSessionId: null,
    agentId: null,
  }
}

/** `agent-<id>.jsonl` -> `<id>`. */
function subagentIdOf(fileName: string): string | null {
  return /^agent-(.+)\.jsonl$/.exec(fileName)?.[1] ?? null
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
    const stat = statOf(filePath)
    if (stat !== null && stat.mtimeMs >= cutoffMs) {
      out.push({
        path: filePath,
        ...stat,
        sessionId: parentSessionId,
        isSubagent: true,
        parentSessionId,
        agentId: subagentIdOf(entry.name),
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
      const stat = statOf(filePath)
      const { sessionId } = claudeIdentify(filePath, root)
      if (stat !== null && stat.mtimeMs >= cutoffMs) {
        found.push({ path: filePath, ...stat, sessionId, isSubagent: false, parentSessionId: null, agentId: null })
      }
      // Sub-agent transcripts are listed even when the parent aged out: they
      // carry their own content and their own mtime.
      walkClaudeSubagents(filePath, sessionId, cutoffMs, 0, found)
    }
  }
  return found
}

// ── Codex: <root>/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl[.zst] ────────────

function walkCodex(root: string, cutoffMs: number, dir = root, depth = 0): SessionFile[] {
  if (depth > MAX_WALK_DEPTH) return []
  const found: SessionFile[] = []
  const entries = readDirSafe(dir)
  const names = new Set(entries.map((entry) => entry.name))
  for (const entry of entries) {
    const filePath = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walkCodex(root, cutoffMs, filePath, depth + 1))
      continue
    }
    if (!isListableTranscript(entry.name, names)) continue
    const stat = statOf(filePath)
    if (stat === null || stat.mtimeMs < cutoffMs) continue
    found.push({
      path: filePath,
      ...stat,
      sessionId: descriptorFor("codex").sessionFile.sessionId(entry.name) ?? "",
      isSubagent: false,
      parentSessionId: null,
      agentId: null,
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
    const stat = statOf(filePath)
    if (stat === null || stat.mtimeMs < cutoffMs) continue
    found.push({
      path: filePath,
      ...stat,
      sessionId: entry.name,
      isSubagent: false,
      parentSessionId: null,
      agentId: null,
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
        if (statOf(candidate) !== null) return candidate
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
      agentId: null,
    }),
    // A rollout's date nesting cannot be rebuilt from the id, so the tree is
    // walked; every rollout carries the id in its file name.
    find(root, sessionId) {
      const walk = (dir: string, depth: number): string | null => {
        if (depth > MAX_WALK_DEPTH) return null
        const entries = readDirSafe(dir)
        const names = new Set(entries.map((entry) => entry.name))
        for (const entry of entries) {
          const filePath = join(dir, entry.name)
          if (entry.isDirectory()) {
            const match = walk(filePath, depth + 1)
            if (match) return match
            continue
          }
          if (uncompressedTranscriptName(entry.name).endsWith(`${sessionId}.jsonl`) && isListableTranscript(entry.name, names)) {
            return filePath
          }
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
      agentId: null,
    }),
    find(root, sessionId) {
      const candidate = copilotTranscript(root, sessionId)
      return statOf(candidate) === null ? null : candidate
    },
  },
  acp: {
    root: () => dirs.ACP_PROJECTS_DIR,
    list: walkClaude,
    identify: claudeIdentify,
    find: (root, id) => WALKERS.claude.find(root, id),
  },
}

function makeStore(kind: AgentKind, home?: string, configuredId?: string): AgentSessionStore {
  const walker = WALKERS[kind]
  const instanceId = configuredId ?? (process.env.COGPIT_WORKER_AGENT === kind ? process.env.COGPIT_AGENT_INSTANCE_ID : undefined) ?? "default"
  const root = home ? () => join(home, kind === "codex" ? "sessions" : kind === "copilot" ? "session-state" : "projects") : walker.root
  const identify = (filePath: string, directory = root()): SessionFileIdentity => {
    const identity = walker.identify(filePath, directory)
    return { ...identity, sessionId: instanceSessionId(instanceId, identity.sessionId), parentSessionId: identity.parentSessionId ? instanceSessionId(instanceId, identity.parentSessionId) : null }
  }
  return {
    kind,
    instanceId,
    descriptor: descriptorFor(kind),
    root,
    ownsPath: (filePath) => { if (isWithin(resolve(root()), resolve(filePath))) return true; try { return isWithin(realpathSync(root()), realpathSync(filePath)) } catch { return false } },
    identify,
    list: (cutoffMs, directory = root()) => walker.list(directory, cutoffMs).map((file) => ({ ...file, ...identify(file.path, directory) })),
    find: (sessionId) => { const parts = splitInstanceSessionId(sessionId); return parts.instanceId === instanceId ? walker.find(root(), parts.nativeId) : null },
  }
}

const STORES: Record<AgentKind, AgentSessionStore> = {
  claude: makeStore("claude"),
  codex: makeStore("codex"),
  copilot: makeStore("copilot"),
  acp: makeStore("acp"),
}

export function storeFor(kind: AgentKind): AgentSessionStore {
  return STORES[kind]
}

/** The store a path under no known root is read with: the agent that owns every unprefixed project. */
export function defaultStore(): AgentSessionStore {
  return storeFor(descriptorForDirName(null).kind)
}

/** In a provider worker, the account instance it runs as; it reads only that account's history. */
export function workerInstanceId(): string | null {
  const instanceId = process.env.COGPIT_AGENT_INSTANCE_ID
  return instanceId && AGENT_KINDS.includes(process.env.COGPIT_WORKER_AGENT as AgentKind) ? instanceId : null
}

/** The subagent a transcript path belongs to, or null for a session's own transcript. */
export function subagentIdForPath(filePath: string): string | null {
  const segments = filePath.split(/[\\/]/)
  return segments.at(-2) === SUBAGENTS_DIR ? subagentIdOf(segments.at(-1) ?? "") : null
}

/** Every store, in registry order. */
export function allStores(): readonly AgentSessionStore[] {
  if (workerInstanceId()) return [STORES[process.env.COGPIT_WORKER_AGENT as AgentKind]]
  const stores = AGENT_KINDS.map((kind) => STORES[kind])
  const root = process.env.COGPIT_ORCHESTRATION_ROOT
  if (!root) return stores
  for (const entry of readDirSafe(join(root, "provider-instances"))) {
    if (!entry.isDirectory()) continue
    const home = join(root, "provider-instances", entry.name)
    try {
      const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { providerInstance?: { id?: string; agent?: AgentKind } }
      if (config.providerInstance?.id === entry.name && config.providerInstance.agent && AGENT_KINDS.includes(config.providerInstance.agent)) stores.push(makeStore(config.providerInstance.agent, home, entry.name))
    } catch { /* An incomplete configuration is not a transcript root. */ }
  }
  return stores
}

/** The store whose root contains `filePath`, or null when none does. */
export function storeForPath(filePath: string): AgentSessionStore | null {
  return allStores().find((store) => store.ownsPath(filePath)) ?? null
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
function isSinglePathSegment(value: string): boolean {
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
