// Workflow wire contracts shared by server/lib/workflows.ts and the React panel.

export interface WorkflowPhaseMeta {
  title: string
  detail?: string
}

export interface WorkflowAgent {
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
  agents: WorkflowAgent[]
  script?: string
  error?: string
  resultPreview?: string
  /** Whether the owning session is a live Cogpit-managed process (force-stoppable). */
  controllable?: boolean
}

const TERMINAL_AGENT_STATES = new Set(["done", "error", "skipped"])

/** True once an agent has reached a terminal state. */
export function isTerminalAgentState(state: string): boolean {
  return TERMINAL_AGENT_STATES.has(state)
}
