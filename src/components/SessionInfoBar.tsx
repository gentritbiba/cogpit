import { memo } from "react"
import { MobileSessionInfoBar, type SessionInfoBarProps } from "@/components/SessionInfoBar.mobile"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { parseSubAgentPath } from "@/lib/format"
import { capabilitiesForDirName } from "@/lib/agents"

export const SessionInfoBar = memo(function SessionInfoBar(props: SessionInfoBarProps) {
  const { isMobile } = useAppContext()
  const { session, sessionSource, isLive, permissions, actions } = useSessionContext()
  if (!isMobile || !session) return null

  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const contextUsage = capabilitiesForDirName(sessionSource?.dirName).contextWindow ? session.digest.contextUsage : null

  return (
    <MobileSessionInfoBar
      {...props}
      session={session}
      sessionSource={sessionSource}
      isSubAgentView={subAgentInfo !== null}
      isLive={isLive}
      canArchive={permissions.archive}
      onProviderHandoff={permissions.send && subAgentInfo === null ? actions.handleProviderHandoff : undefined}
      contextUsage={contextUsage}
    />
  )
})
