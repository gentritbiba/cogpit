// ── What edition UI may use of core ─────────────────────────────────────
//
// Besides the seam itself (src/edition/), the shadcn primitives
// (src/components/ui/) and the shared contracts, edition UI reaches core only
// through these exports. Each one is a promise to a package that core's own
// CI cannot build, so the list is pinned by __tests__/sdk.test.ts: a rename
// or removal here breaks the edition, and changing the list is deliberate.

export { agentKindForDirName } from "@/lib/agents"
export { agentProjectBadge } from "@/lib/agents/presentation"
export { authFetch, jsonFetch } from "@/lib/auth"
export { clearSessionListCache } from "@/lib/sessionListCache"
export { devicePathPrefix, deviceScopedKey, isRemoteDeviceActive, LOCAL_DEVICE_ID, switchDevice } from "@/lib/device"
export { dirNameToPath, formatCost, formatRelativeTime, formatTokenCount } from "@/lib/format"
export { readError, readJson } from "@/lib/httpJson"
export { revealSessionById } from "@/lib/revealSession"
export { publishListsStale, publishSessionAccess, sessionAccessTicket } from "@/lib/sessionAccess"
export { cn } from "@/lib/utils"
export { can, getCurrentUser, subscribeCapabilities } from "@/lib/capabilities"
export { useCapability } from "@/hooks/useCapability"
export { useCurrentUser } from "@/hooks/useCurrentUser"
export { useDevices } from "@/hooks/useDevices"
export { useProjectNames } from "@/hooks/useProjectNames"
export { useSessionContext } from "@/contexts/SessionContext"
export { HeaderIconButton } from "@/components/header-shared"
export { projectGroupKey } from "@/components/LiveSessions/sessionListView"
export { useProjectList } from "@/components/ProjectSwitcherList"
export { ConfirmActionDialog } from "@/components/shared/ConfirmActionDialog"
export { InlineEditPanel } from "@/components/shared/InlineEditPanel"
