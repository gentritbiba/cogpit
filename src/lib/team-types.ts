// ── Team Config ─────────────────────────────────────────────────────────────

export interface TeamMember {
  agentId: string
  name: string
  agentType: string
  model?: string
  prompt?: string
  color?: string
  joinedAt: number
  cwd?: string
}

export interface TeamConfig {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
}

// ── Member Helpers ──────────────────────────────────────────────────────────

/** Check if a team member is the team lead */
export function isTeamLead(member: TeamMember): boolean {
  return member.agentType === "team-lead"
}

/** Get the effective color for a member (leads use default zinc) */
export function getMemberEffectiveColor(member: TeamMember): string | undefined {
  return isTeamLead(member) ? undefined : member.color
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
