import type { ToolCall as ParsedToolCall } from "@/lib/types"

// ─── Branch Colors ────────────────────────────────────────────

export const BRANCH_COLORS = ["#3b82f6", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899", "#22c55e"]
export const BRANCH_INNER = ["#60a5fa", "#c084fc", "#fbbf24", "#22d3ee", "#f472b6", "#4ade80"]

// ─── Tool style map ───────────────────────────────────────────

/**
 * BranchModal tool badge styles — used in TurnCards for the historical turn summary.
 *
 * High-contrast border+text only (no background fill), giving all tools equal visual
 * weight in a compact archived-turn list. Uses more opaque border/text than the
 * timeline variant to stay readable against the modal's elevated surface.
 *
 * Distinct from ToolCallCard's TIMELINE_TOOL_BADGE_STYLES (timeline/ToolCallCard.tsx),
 * which uses desaturated backgrounds for a dense live-streaming timeline view.
 */
export const TOOL_BADGE_STYLES: Record<string, string> = {
  Read: "border-blue-700/50 text-blue-400",
  Edit: "border-amber-700/50 text-amber-400",
  Write: "border-green-700/50 text-green-400",
  Bash: "border-red-700/50 text-red-400",
  Grep: "border-purple-700/50 text-purple-400",
  Glob: "border-cyan-700/50 text-cyan-400",
  Task: "border-indigo-700/50 text-indigo-400",
  WebFetch: "border-teal-700/50 text-teal-400",
  WebSearch: "border-teal-700/50 text-teal-400",
}

export function toolSummary(tc: ParsedToolCall): string {
  const fp = (tc.input.file_path ?? tc.input.path ?? "") as string
  if (fp) return fp.split("/").pop() || fp
  const cmd = tc.input.command as string | undefined
  if (cmd) return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd
  const pat = tc.input.pattern as string | undefined
  if (pat) return pat.length > 30 ? pat.slice(0, 27) + "..." : pat
  const query = tc.input.query as string | undefined
  if (query) return query.length > 30 ? query.slice(0, 27) + "..." : query
  return ""
}
