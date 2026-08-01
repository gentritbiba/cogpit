import type { ToolCall as ParsedToolCall } from "@/lib/types"

// ─── Branch Colors ────────────────────────────────────────────

export const BRANCH_COLORS = ["#3b82f6", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899", "#22c55e"]
export const BRANCH_INNER = ["#60a5fa", "#c084fc", "#fbbf24", "#22d3ee", "#f472b6", "#4ade80"]

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
