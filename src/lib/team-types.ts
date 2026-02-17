// ── Team Config ─────────────────────────────────────────────────────────────

export interface TeamMember {
  agentId: string
  name: string
  agentType: string
  model?: string
  prompt?: string
  color?: string
  planModeRequired?: boolean
  joinedAt: number
  tmuxPaneId?: string
  cwd?: string
  backendType?: string
}

export interface TeamConfig {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface TeamTask {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: "pending" | "in_progress" | "completed" | "deleted"
  blocks: string[]
  blockedBy: string[]
  owner?: string
}

// ── Inboxes ─────────────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string
  text: string
  timestamp: string
  color?: string
  read?: boolean
  summary?: string
}

// ── API Response Types ──────────────────────────────────────────────────────

export interface TaskSummary {
  total: number
  completed: number
  inProgress: number
  pending: number
}

export interface TeamListItem {
  name: string
  description?: string
  createdAt: number
  memberCount: number
  leadName: string
  taskSummary: TaskSummary
}

export interface TeamDetail {
  config: TeamConfig
  tasks: TeamTask[]
  inboxes: Record<string, InboxMessage[]>
}

// ── Member Color Mapping ────────────────────────────────────────────────────

const MEMBER_COLORS: Record<string, string> = {
  blue: "bg-blue-500",
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
}

export function getMemberColorClass(color?: string): string {
  if (!color) return "bg-zinc-400"
  return MEMBER_COLORS[color] ?? "bg-zinc-400"
}

export function getMemberTextColorClass(color?: string): string {
  const map: Record<string, string> = {
    blue: "text-blue-400",
    green: "text-green-400",
    yellow: "text-yellow-400",
    purple: "text-purple-400",
    orange: "text-orange-400",
  }
  if (!color) return "text-zinc-400"
  return map[color] ?? "text-zinc-400"
}

export function getMemberBorderClass(color?: string): string {
  const map: Record<string, string> = {
    blue: "border-blue-500/30",
    green: "border-green-500/30",
    yellow: "border-yellow-500/30",
    purple: "border-purple-500/30",
    orange: "border-orange-500/30",
  }
  if (!color) return "border-zinc-700"
  return map[color] ?? "border-zinc-700"
}
