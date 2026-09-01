import { memo } from "react"
import { MobileSessionInfoBar, type SessionInfoBarProps } from "@/components/SessionInfoBar.mobile"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { parseSubAgentPath } from "@/lib/format"
import type { RawMessage } from "@/lib/types"

export const SessionInfoBar = memo(function SessionInfoBar(props: SessionInfoBarProps) {
  const { isMobile } = useAppContext()
  const { session, sessionSource } = useSessionContext()
  if (!isMobile || !session) return null

  const subAgentInfo = sessionSource ? parseSubAgentPath(sessionSource.fileName) : null
  const claudeRawMessages = (
    session.agentKind === "claude" ? session.rawMessages : []
  ) as readonly RawMessage[]

  return (
    <MobileSessionInfoBar
      {...props}
      onDuplicateSession={props.onDuplicateSession}
      session={session}
      sessionSource={sessionSource}
      isSubAgentView={subAgentInfo !== null}
      claudeRawMessages={claudeRawMessages}
    />
  )
})
