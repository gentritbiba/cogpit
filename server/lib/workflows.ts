/**
 * Workflow journal parsing.
 *
 * Claude Code's Workflow tool writes live events at
 *   <PROJECTS_DIR>/<dirName>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
 * and creates the full JSON journal only when the run finishes at
 *   <PROJECTS_DIR>/<dirName>/<sessionId>/workflows/wf_<runId>.json
 *
 * The event journal is appended throughout the run, so watching it gives a
 * live feed. This module reads + normalizes both formats into the summary/detail
 * shapes the API serves. Normalization is split into pure functions
 * (summarizeJournal / normalizeDetail) so they can be unit-tested without fs.
 */
import { dirs, isWithinDir, readdir, readFile, stat, join } from "../helpers"

// ── Wire types (mirror src/lib/workflow-types.ts) ───────────────────────────

export interface WorkflowPhaseMeta {
  title: string
  detail?: string
}

export interface WorkflowAgentEntry {
  type: "workflow_agent"
  index: number
  label: string
  phaseIndex: number
  phaseTitle: string
  agentId: string
  model?: string
  state: string
  startedAt?: number
  queuedAt?: number
  attempt?: number
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  lastProgressAt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
  resultPreview?: string
}

interface WorkflowPhaseEntry {
  type: "workflow_phase"
  index: number
  title: string
}

type WorkflowProgressEntry = WorkflowAgentEntry | WorkflowPhaseEntry

/** Raw shape of a wf_<runId>.json journal (only the fields we read). */
export interface WorkflowJournal {
  runId?: string
  taskId?: string
  workflowName?: string
  summary?: string
  status?: string
  startTime?: number
  durationMs?: number
  defaultModel?: string
  agentCount?: number
  totalTokens?: number
  totalToolCalls?: number
  phases?: WorkflowPhaseMeta[]
  workflowProgress?: WorkflowProgressEntry[]
  script?: string
  error?: string
  result?: unknown
}

interface LiveWorkflowEvent {
  type?: string
  agentId?: string
  result?: unknown
}

export interface WorkflowAgentCounts {
  total: number
  queued: number
  running: number
  done: number
  error: number
}

export interface WorkflowSummary {
  runId: string
  taskId?: string
  workflowName: string
  summary: string
  status: string
  startTime: number
  durationMs?: number
  agentCount: number
  totalTokens: number
  totalToolCalls: number
  phaseCount: number
  phaseTitles: string[]
  agentCounts: WorkflowAgentCounts
}

export interface WorkflowDetail extends WorkflowSummary {
  defaultModel?: string
  phases: WorkflowPhaseMeta[]
  agents: WorkflowAgentEntry[]
  script?: string
  error?: string
  resultPreview?: string
}

// ── Pure normalization ──────────────────────────────────────────────────────

const TERMINAL_STATES = new Set(["done", "error", "skipped"])

/** True once an agent has reached a terminal state. */
export function isTerminalAgentState(state: string): boolean {
  return TERMINAL_STATES.has(state)
}

function countAgents(progress: WorkflowProgressEntry[]): WorkflowAgentCounts {
  const counts: WorkflowAgentCounts = { total: 0, queued: 0, running: 0, done: 0, error: 0 }
  for (const e of progress) {
    if (e.type !== "workflow_agent") continue
    counts.total++
    switch (e.state) {
      case "queued":
        counts.queued++
        break
      case "done":
      case "skipped":
        counts.done++
        break
      case "error":
        counts.error++
        break
      default:
        // running, progress, or any non-terminal state
        counts.running++
    }
  }
  return counts
}

export function summarizeJournal(runId: string, journal: WorkflowJournal): WorkflowSummary {
  const progress = Array.isArray(journal.workflowProgress) ? journal.workflowProgress : []
  const phases = Array.isArray(journal.phases) ? journal.phases : []
  return {
    runId: journal.runId || runId,
    taskId: journal.taskId,
    workflowName: journal.workflowName || runId,
    summary: journal.summary || "",
    status: journal.status || "running",
    startTime: journal.startTime || 0,
    durationMs: journal.durationMs,
    agentCount: journal.agentCount ?? countAgents(progress).total,
    totalTokens: journal.totalTokens ?? 0,
    totalToolCalls: journal.totalToolCalls ?? 0,
    phaseCount: phases.length,
    phaseTitles: phases.map((p) => p.title),
    agentCounts: countAgents(progress),
  }
}

function truncate(value: unknown, max: number): string | undefined {
  if (value == null) return undefined
  let s: string
  try {
    s = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return undefined
  }
  if (!s) return undefined
  return s.length > max ? s.slice(0, max) + "…" : s
}

export function normalizeDetail(runId: string, journal: WorkflowJournal): WorkflowDetail {
  const progress = Array.isArray(journal.workflowProgress) ? journal.workflowProgress : []
  const agents = progress.filter((e): e is WorkflowAgentEntry => e.type === "workflow_agent")
  return {
    ...summarizeJournal(runId, journal),
    defaultModel: journal.defaultModel,
    phases: Array.isArray(journal.phases) ? journal.phases : [],
    agents,
    script: journal.script,
    error: journal.error,
    resultPreview: truncate(journal.result, 4000),
  }
}

// ── Filesystem access ────────────────────────────────────────────────────────

/** Absolute path to a session's workflows journal directory. */
export function workflowsDirFor(dirName: string, sessionId: string): string | null {
  const dir = join(dirs.PROJECTS_DIR, dirName, sessionId, "workflows")
  return isWithinDir(dirs.PROJECTS_DIR, dir) ? dir : null
}

/** The session directory that holds workflows/ and subagents/workflows/. */
export function sessionDirFor(dirName: string, sessionId: string): string | null {
  const dir = join(dirs.PROJECTS_DIR, dirName, sessionId)
  return isWithinDir(dirs.PROJECTS_DIR, dir) ? dir : null
}

function isWorkflowFile(name: string): boolean {
  return name.startsWith("wf_") && name.endsWith(".json")
}

/**
 * A safe run id: `wf_` prefixed, alphanumerics/`-`/`_` only. Rejects path
 * separators and `..` so a crafted runId can't escape the workflows dir.
 * (Matches the runtime's `^wf_[a-z0-9-]{6,}$` shape, permissively.)
 */
function isSafeRunId(runId: string): boolean {
  return /^wf_[A-Za-z0-9_-]+$/.test(runId)
}

/** runId for a journal filename (wf_xxx.json → wf_xxx). */
function runIdFromFile(name: string): string {
  return name.replace(/\.json$/, "")
}

async function readJournal(dir: string, runId: string): Promise<WorkflowJournal | null> {
  try {
    const raw = await readFile(join(dir, `${runId}.json`), "utf-8")
    return JSON.parse(raw) as WorkflowJournal
  } catch {
    return null
  }
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

function liveWorkflowsDirFor(dirName: string, sessionId: string): string | null {
  const sessionDir = sessionDirFor(dirName, sessionId)
  if (!sessionDir) return null
  const dir = join(sessionDir, "subagents", "workflows")
  return isWithinDir(dirs.PROJECTS_DIR, dir) ? dir : null
}

/** Build a best-effort running detail from the append-only live event journal. */
async function readLiveWorkflowDetail(
  dir: string,
  runId: string,
): Promise<WorkflowDetail | null> {
  const runDir = join(dir, runId)
  if (!isWithinDir(dir, runDir)) return null
  const journalPath = join(runDir, "journal.jsonl")

  let raw: string
  try {
    raw = await readFile(journalPath, "utf-8")
  } catch {
    return null
  }

  let startTime = 0
  try {
    const journalStat = await stat(journalPath)
    startTime = journalStat.birthtimeMs || journalStat.ctimeMs || 0
  } catch {
    // The events still identify the live agents even when metadata is unavailable.
  }

  const agents = new Map<string, WorkflowAgentEntry>()
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let event: LiveWorkflowEvent
    try {
      event = JSON.parse(line) as LiveWorkflowEvent
    } catch {
      // The final line can be temporarily incomplete while the runtime appends it.
      continue
    }
    if (!event.agentId || (event.type !== "started" && event.type !== "result")) continue

    let agent = agents.get(event.agentId)
    if (!agent) {
      const index = agents.size + 1
      agent = {
        type: "workflow_agent",
        index,
        label: `Agent ${index}`,
        phaseIndex: 1,
        phaseTitle: "Agents",
        agentId: event.agentId,
        state: "running",
        startedAt: startTime || undefined,
      }
      agents.set(event.agentId, agent)
    }
    if (event.type === "result") {
      agent.state = "done"
      agent.resultPreview = truncate(event.result, 4000)
    }
  }

  if (agents.size === 0) return null
  const liveAgents = [...agents.values()]
  const phases: WorkflowPhaseMeta[] = [{ title: "Agents" }]
  const progress: WorkflowProgressEntry[] = [
    { type: "workflow_phase", index: 1, title: "Agents" },
    ...liveAgents,
  ]
  return normalizeDetail(runId, {
    runId,
    workflowName: runId,
    status: "running",
    startTime,
    agentCount: liveAgents.length,
    phases,
    workflowProgress: progress,
  })
}

/** List all workflows for a session, newest first. Returns [] when none. */
export async function listSessionWorkflows(
  dirName: string,
  sessionId: string,
): Promise<WorkflowSummary[]> {
  const completedDir = workflowsDirFor(dirName, sessionId)
  const liveDir = liveWorkflowsDirFor(dirName, sessionId)
  if (!completedDir || !liveDir) return []

  const [completedFiles, liveEntries] = await Promise.all([
    readDir(completedDir),
    readDir(liveDir),
  ])
  const completedRunIds = completedFiles.filter(isWorkflowFile).map(runIdFromFile)
  const liveRunIds = liveEntries.filter(isSafeRunId)
  const runIds = [...new Set([...completedRunIds, ...liveRunIds])]

  // Prefer the full completion journal; fall back to the live event journal
  // while the runtime has not created that final file yet.
  const summaries = await Promise.all(runIds.map(async (runId) => {
    const journal = await readJournal(completedDir, runId)
    if (journal) return summarizeJournal(runId, journal)
    return readLiveWorkflowDetail(liveDir, runId)
  }))

  return summaries
    .filter((summary): summary is WorkflowSummary => summary !== null)
    .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
}

/** Full detail for one workflow run, or null when the journal is missing. */
export async function readWorkflowDetail(
  dirName: string,
  sessionId: string,
  runId: string,
): Promise<WorkflowDetail | null> {
  if (!isSafeRunId(runId)) return null
  const completedDir = workflowsDirFor(dirName, sessionId)
  const liveDir = liveWorkflowsDirFor(dirName, sessionId)
  if (!completedDir || !liveDir) return null
  // Defense in depth: confirm the resolved journal path stays inside the dir.
  if (!isWithinDir(completedDir, join(completedDir, `${runId}.json`))) return null
  const journal = await readJournal(completedDir, runId)
  if (journal) return normalizeDetail(runId, journal)
  return readLiveWorkflowDetail(liveDir, runId)
}
