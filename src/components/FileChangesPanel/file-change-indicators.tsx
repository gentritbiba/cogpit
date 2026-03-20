/**
 * Shared indicator components used by both GroupedFileCard and TurnChangedFiles.
 */
import type { GitFileStatus } from "./useFileChangesData"

/** Custom event name for navigating to a sub-agent's chat view. */
export const OPEN_SUBAGENT_EVENT = "cogpit:open-subagent"

const GIT_STATUS_COLORS: Record<GitFileStatus, string> = {
  A: "text-green-400",
  M: "text-yellow-400",
  D: "text-red-400",
  R: "text-blue-400",
}

export function GitStatusBadge({ status }: { status: GitFileStatus }) {
  return (
    <span className={`text-[9px] font-bold shrink-0 ${GIT_STATUS_COLORS[status]}`}>
      {status}
    </span>
  )
}

export function OpIndicator({ hasEdit, hasWrite }: { hasEdit: boolean; hasWrite: boolean }) {
  if (hasEdit && hasWrite) {
    return <span className="text-[9px] font-bold shrink-0 text-amber-400/60">E+W</span>
  }
  if (hasWrite) {
    return <span className="text-[9px] font-bold shrink-0 text-green-400/60">W</span>
  }
  return <span className="text-[9px] font-bold shrink-0 text-amber-400/60">E</span>
}

export function SubAgentIndicator({ agentId }: { agentId: string }) {
  return (
    <span
      className="text-[9px] font-bold shrink-0 text-indigo-400/60 cursor-pointer hover:text-indigo-400 transition-colors"
      title="Open sub-agent view"
      onClick={(e) => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { agentId } }))
      }}
    >
      S
    </span>
  )
}
