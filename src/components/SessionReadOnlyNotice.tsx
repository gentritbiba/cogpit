import type { LucideIcon } from "lucide-react"
import { Bot, Eye, ShieldEllipsis, ShieldX } from "lucide-react"
import { PermissionRequestBar } from "@/components/ChatInput/PermissionRequestBar"
import { PlanApprovalBar } from "@/components/ChatInput/PlanApprovalBar"
import { useSessionContext } from "@/contexts/SessionContext"
import { useEditionUi } from "@/edition/hooks"
import type { SessionAccess } from "@/hooks/useSessionAccess"
import type { AgentKind } from "@/lib/agents"
import { readOnlySessionNotice } from "@/lib/agents/presentation"
import { permissionsForAccess } from "@/lib/sessionAccessPermissions"

export type ReadOnlyReason =
  | { kind: "subagent" }
  | { kind: "external"; agentKind: AgentKind }
  | { kind: "view-only" }
  | { kind: "checking" }
  | { kind: "no-access" }

/** Why the user's access to a session leaves it read-only, or null when they may drive it. */
export function accessReadOnlyReason({ level }: SessionAccess): ReadOnlyReason | null {
  if (level === "unknown") return { kind: "checking" }
  if (level === "none") return { kind: "no-access" }
  return permissionsForAccess(level).canInteract ? null : { kind: "view-only" }
}

/** Stands in for the composer when the session can be read but not driven. */
export function SessionReadOnlyNotice({ reason }: { reason: ReadOnlyReason }) {
  switch (reason.kind) {
    case "subagent":
      return <Banner icon={Bot}>Viewing sub-agent session (read-only)</Banner>
    case "external":
      return <Banner icon={Bot} status>{readOnlySessionNotice(reason.agentKind)}</Banner>
    case "no-access":
      return <Banner icon={ShieldX} status>You don't have access to this session</Banner>
    case "checking":
      return <ReaderBanner icon={ShieldEllipsis}>Checking access…</ReaderBanner>
    case "view-only":
      return <ReaderBanner icon={Eye}><ViewOnlyNote /></ReaderBanner>
  }
}

/** The edition may say more about a session the user can only view. */
function ViewOnlyNote() {
  const { ReadOnlyNote } = useEditionUi()
  const { session } = useSessionContext()
  return ReadOnlyNote && session ? <ReadOnlyNote sessionId={session.sessionId} /> : "View only"
}

/** A reader still sees what the session is waiting on, without the controls to answer it. */
function ReaderBanner({ icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="shrink-0">
      <PendingPrompts />
      <Banner icon={icon} status>{children}</Banner>
    </div>
  )
}

function PendingPrompts() {
  const { pendingInteraction, permissionRequests } = useSessionContext()
  const plan = pendingInteraction?.type === "plan" ? pendingInteraction : null
  if (!plan && permissionRequests.length === 0) return null
  return (
    <div className="px-3 pt-2">
      {plan && (
        <PlanApprovalBar
          allowedPrompts={plan.allowedPrompts}
          summary={plan.summary}
          planContent={plan.planContent}
        />
      )}
      {permissionRequests.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-xl border border-warning/40 bg-popover">
          <PermissionRequestBar requests={permissionRequests} />
        </div>
      )}
    </div>
  )
}

function Banner({ icon: Icon, status = false, children }: {
  icon: LucideIcon
  status?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      role={status ? "status" : undefined}
      className="flex shrink-0 items-center justify-center gap-2 border-t bg-card px-4 py-2.5"
    >
      <Icon data-icon="inline-start" className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  )
}
