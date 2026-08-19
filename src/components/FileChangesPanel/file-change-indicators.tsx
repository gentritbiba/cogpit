/**
 * Shared indicator components used by both GroupedFileCard and TurnChangedFiles.
*/
import { Button } from "@/components/ui/button"

/** Custom event name for navigating to a sub-agent's chat view. */
export const OPEN_SUBAGENT_EVENT = "cogpit:open-subagent"

export function OpIndicator({ hasEdit, hasWrite }: { hasEdit: boolean; hasWrite: boolean }) {
  if (hasEdit && hasWrite) {
    return <span className="shrink-0 text-xs font-bold text-warning">E+W</span>
  }
  if (hasWrite) {
    return <span className="shrink-0 text-xs font-bold text-success">W</span>
  }
  return <span className="shrink-0 text-xs font-bold text-warning">E</span>
}

export function SubAgentIndicator({ agentId }: { agentId: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 font-mono text-xs font-bold text-muted-foreground"
      aria-label="Open sub-agent view"
      title="Open sub-agent view"
      onClick={(e) => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { agentId } }))
      }}
    >
      S
    </Button>
  )
}
