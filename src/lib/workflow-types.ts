// ── Workflow types (wire shape mirrors server/lib/workflows.ts) ──────────────

export interface WorkflowPhaseMeta {
  title: string
  detail?: string
}

export type WorkflowAgentState = "queued" | "running" | "progress" | "done" | "error" | "skipped" | string

export interface WorkflowAgent {
  type: "workflow_agent"
  index: number
  label: string
  phaseIndex: number
  phaseTitle: string
  agentId: string
  model?: string
  state: WorkflowAgentState
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

export interface WorkflowAgentCounts {
  total: number
  queued: number
  running: number
  done: number
  error: number
}

export type WorkflowStatus = "running" | "completed" | "failed" | "killed" | string

export interface WorkflowSummary {
  runId: string
  taskId?: string
  workflowName: string
  summary: string
  status: WorkflowStatus
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
  agents: WorkflowAgent[]
  script?: string
  error?: string
  resultPreview?: string
  /** Whether the owning session is a live Cogpit-managed process (force-stoppable). */
  controllable?: boolean
}

// ── Status / state helpers ───────────────────────────────────────────────────

const TERMINAL_AGENT_STATES = new Set(["done", "error", "skipped"])
export function isTerminalAgentState(state: string): boolean {
  return TERMINAL_AGENT_STATES.has(state)
}

/** A workflow is still in flight when not in a terminal status. */
export function isWorkflowActive(status: string): boolean {
  return status !== "completed" && status !== "failed" && status !== "killed"
}

export interface StatusStyle {
  label: string
  /** Tailwind text + border classes for a badge. */
  badge: string
  /** Tailwind dot color. */
  dot: string
}

export function workflowStatusStyle(status: string): StatusStyle {
  switch (status) {
    case "completed":
      return { label: "Completed", badge: "text-emerald-400 border-emerald-700/50 bg-emerald-500/10", dot: "bg-emerald-500" }
    case "failed":
      return { label: "Failed", badge: "text-red-400 border-red-700/50 bg-red-500/10", dot: "bg-red-500" }
    case "killed":
      return { label: "Stopped", badge: "text-amber-400 border-amber-700/50 bg-amber-500/10", dot: "bg-amber-500" }
    default:
      return { label: "Running", badge: "text-blue-400 border-blue-700/50 bg-blue-500/10", dot: "bg-blue-500" }
  }
}

export function agentStateStyle(state: string): StatusStyle {
  switch (state) {
    case "done":
      return { label: "Done", badge: "text-emerald-400 border-emerald-700/50 bg-emerald-500/10", dot: "bg-emerald-500" }
    case "skipped":
      return { label: "Skipped", badge: "text-zinc-400 border-border bg-muted/30", dot: "bg-zinc-500" }
    case "error":
      return { label: "Error", badge: "text-red-400 border-red-700/50 bg-red-500/10", dot: "bg-red-500" }
    case "queued":
      return { label: "Queued", badge: "text-zinc-400 border-border bg-muted/30", dot: "bg-zinc-500" }
    default:
      return { label: "Running", badge: "text-blue-400 border-blue-700/50 bg-blue-500/10", dot: "bg-blue-500" }
  }
}

// ── Grouping ─────────────────────────────────────────────────────────────────

export interface PhaseGroup {
  index: number
  title: string
  detail?: string
  agents: WorkflowAgent[]
}

/**
 * Group a run's agents by phase, preserving phase order from `phases`.
 * Agents whose phase isn't listed (or phase 0) fall into an "Ungrouped"
 * bucket appended at the end so nothing is silently dropped.
 */
export function groupAgentsByPhase(detail: WorkflowDetail): PhaseGroup[] {
  const groups = new Map<number, PhaseGroup>()
  detail.phases.forEach((p, i) => {
    const index = i + 1
    groups.set(index, { index, title: p.title, detail: p.detail, agents: [] })
  })

  const ungrouped: WorkflowAgent[] = []
  for (const agent of detail.agents) {
    const group = groups.get(agent.phaseIndex)
    if (group) group.agents.push(agent)
    else ungrouped.push(agent)
  }

  const ordered = [...groups.values()]
  if (ungrouped.length > 0) {
    ordered.push({ index: ordered.length + 1, title: ungrouped[0].phaseTitle || "Other", agents: ungrouped })
  }
  // Sort agents within a phase by their launch index for stable display.
  for (const g of ordered) g.agents.sort((a, b) => a.index - b.index)
  return ordered
}

/** Fraction (0–1) of agents that have reached a terminal state. */
export function agentProgress(counts: WorkflowAgentCounts): number {
  if (counts.total === 0) return 0
  return (counts.done + counts.error) / counts.total
}

/** Compact token formatting: 65739 → "65.7k". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}
