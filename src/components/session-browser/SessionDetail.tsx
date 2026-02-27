import {
  FileText,
  Wrench,
  Clock,
  AlertTriangle,
  MessageSquare,
  GitBranch,
  FolderOpen,
  Cpu,
  Hash,
  Zap,
  Brain,
  ArrowDownLeft,
  ArrowUpRight,
  DollarSign,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import {
  formatDuration,
  formatTokenCount,
  formatCost,
  truncate,
} from "@/lib/format"
import type { ParsedSession } from "@/lib/types"
import { SidebarStatCard } from "./StatCards"
import { TokenBreakdown } from "./TokenBreakdown"

// ── Info Row ───────────────────────────────────────────────────────────────

function InfoRow({
  icon,
  children,
  tooltip,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  tooltip?: string
}): React.ReactElement {
  const content = (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {icon}
      {children}
    </div>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    )
  }

  return content
}

// ── Git Branch Display ─────────────────────────────────────────────────────

function GitBranchDisplay({ branch }: { branch: string }): React.ReactElement {
  if (branch.startsWith("worktree-")) {
    return (
      <span className="rounded bg-emerald-500/10 text-emerald-400 px-1.5 py-px text-[10px] font-medium">
        {branch.replace("worktree-", "")}
      </span>
    )
  }

  return (
    <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
      {branch}
    </Badge>
  )
}

// ── Session Info Section ───────────────────────────────────────────────────

function SessionInfoSection({ session }: { session: ParsedSession }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-l-2 border-blue-500/30 pl-2">
        Session
      </h3>

      <InfoRow
        icon={<Hash className="size-3 shrink-0 text-muted-foreground" />}
        tooltip={session.sessionId}
      >
        <span className="truncate font-mono">
          {truncate(session.sessionId, 20)}
        </span>
      </InfoRow>

      {session.slug && (
        <InfoRow icon={<FileText className="size-3 shrink-0 text-muted-foreground" />}>
          <span className="truncate">{session.slug}</span>
        </InfoRow>
      )}

      <InfoRow icon={<Cpu className="size-3 shrink-0 text-muted-foreground" />}>
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
          {session.model || "unknown"}
        </Badge>
      </InfoRow>

      {session.version && (
        <InfoRow icon={<Zap className="size-3 shrink-0 text-muted-foreground" />}>
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
            v{session.version}
          </Badge>
        </InfoRow>
      )}

      {session.gitBranch && (
        <InfoRow icon={<GitBranch className="size-3 shrink-0 text-muted-foreground" />}>
          <GitBranchDisplay branch={session.gitBranch} />
        </InfoRow>
      )}

      {session.cwd && (
        <InfoRow
          icon={<FolderOpen className="size-3 shrink-0 text-muted-foreground" />}
          tooltip={session.cwd}
        >
          <span className="truncate font-mono text-[10px]">
            {truncate(session.cwd, 28)}
          </span>
        </InfoRow>
      )}
    </div>
  )
}

// ── Stats Grid ─────────────────────────────────────────────────────────────

function StatsGrid({ session }: { session: ParsedSession }): React.ReactElement {
  const totalToolCalls = Object.values(session.stats.toolCallCounts).reduce(
    (a, b) => a + b,
    0
  )
  const totalThinkingBlocks = session.turns.reduce(
    (sum, t) => sum + t.thinking.length,
    0
  )

  return (
    <div className="flex flex-col gap-1.5 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-l-2 border-blue-500/30 pl-2">
        Stats
      </h3>
      <div className="grid grid-cols-2 gap-1.5">
        <SidebarStatCard
          icon={<MessageSquare className="size-3" />}
          label="Turns"
          value={String(session.stats.turnCount)}
        />
        <SidebarStatCard
          icon={<Wrench className="size-3" />}
          label="Tool Calls"
          value={String(totalToolCalls)}
        />
        <SidebarStatCard
          icon={<Brain className="size-3" />}
          label="Thinking"
          value={String(totalThinkingBlocks)}
        />
        <SidebarStatCard
          icon={<AlertTriangle className="size-3" />}
          label="Errors"
          value={String(session.stats.errorCount)}
          variant={session.stats.errorCount > 0 ? "error" : "default"}
        />
        <SidebarStatCard
          icon={<Clock className="size-3" />}
          label="Duration"
          value={formatDuration(session.stats.totalDurationMs)}
        />
        <SidebarStatCard
          icon={<ArrowDownLeft className="size-3" />}
          label="New+Write"
          value={formatTokenCount(
            session.stats.totalInputTokens
            + session.stats.totalCacheCreationTokens
          )}
          tooltip={`New: ${formatTokenCount(session.stats.totalInputTokens)} · Cache write: ${formatTokenCount(session.stats.totalCacheCreationTokens)}`}
        />
        <SidebarStatCard
          icon={<Brain className="size-3" />}
          label="Read"
          value={formatTokenCount(session.stats.totalCacheReadTokens)}
          tooltip="Cache read tokens (served from prompt cache)"
        />
        <SidebarStatCard
          icon={<ArrowUpRight className="size-3" />}
          label="Output"
          value={formatTokenCount(session.stats.totalOutputTokens)}
        />
        <SidebarStatCard
          icon={<DollarSign className="size-3" />}
          label="API Cost"
          value={formatCost(session.stats.totalCostUSD)}
          tooltip="Estimated cost based on Anthropic API pricing"
        />
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export function SessionDetail({ session }: { session: ParsedSession }): React.ReactElement {
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-0 px-3 pb-3">
        <SessionInfoSection session={session} />
        <Separator className="bg-border/50" />
        <StatsGrid session={session} />
        <Separator className="bg-border/50" />
        <TokenBreakdown session={session} />
      </div>
    </ScrollArea>
  )
}
