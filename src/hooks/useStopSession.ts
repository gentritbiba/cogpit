import { useSessionChatContextOptional, useSessionControls } from "@/contexts/SessionContext"
import { agentKindForDirName, capabilitiesFor } from "@/lib/agents"

/**
 * Stop session, while there is a process to stop and the user may stop it.
 * A connected chat counts as running even after the transcript stream has
 * gone quiet, as it did beside the composer's Send.
 */
export function useStopSession(): (() => void) | undefined {
  const { isLive, sessionSource, permissions, actions } = useSessionControls()
  const isConnected = useSessionChatContextOptional()?.chat.isConnected ?? false
  const agentKind = sessionSource?.agentKind ?? agentKindForDirName(sessionSource?.dirName ?? null)
  if (!(isLive || isConnected) || !permissions.send || !capabilitiesFor(agentKind).stopSession) return undefined
  return actions.handleStopSession
}
