import { getStatusLabel } from "../../../shared/session/sessionStatus"
import { agentKindForDirName } from "@/lib/agents"
import { isExternallyDrivenSession } from "@/lib/sessionControl"
import { isIdleStatus } from "./sessionStatusPresentation"
import type { STATUS_DOT } from "./statusDot"
import type { ActiveSessionInfo, RunningProcess } from "./types"

export interface SessionRowState {
  hasProcess: boolean
  isLive: boolean
  /** A natively driven session whose agent is waiting for the next instruction. */
  isNativeIdle: boolean
  isDeferred: boolean
  /** Owned by another client; Cogpit shows it but must not resume or kill it. */
  isReadOnly: boolean
  isTeammate: boolean
  isArchived: boolean
  statusLabel: string | null
  /** Left-edge dot. Sessions that are neither live nor blocked get none. */
  dotState: keyof typeof STATUS_DOT | null
  /** A tracked process that finished since the user last looked. */
  justFinished: boolean
}

/** Everything a session row or card derives from the session and its process. */
export function describeSessionRow(
  s: ActiveSessionInfo,
  proc: RunningProcess | undefined,
  isNewlyCompleted = false,
): SessionRowState {
  const hasProcess = proc !== undefined
  const isNativeLive = s.isActive === true
  const isLive = hasProcess || isNativeLive
  const isNativeIdle = isNativeLive && isIdleStatus(s.agentStatus)
  const isDeferred = s.agentStatus === "deferred"
  const isReadOnly = isExternallyDrivenSession(agentKindForDirName(s.dirName), proc)
  return {
    hasProcess,
    isLive,
    isNativeIdle,
    isDeferred,
    isReadOnly,
    isTeammate: !!(s.teamName && s.agentName),
    isArchived: s.archived === true,
    statusLabel: statusLabelFor(s, { isReadOnly, isLive, isNativeIdle }),
    dotState: dotStateFor(s, { isDeferred, isLive }),
    justFinished: !isNativeLive && hasProcess && s.agentStatus === "completed" && isNewlyCompleted,
  }
}

function statusLabelFor(
  s: ActiveSessionInfo,
  { isReadOnly, isLive, isNativeIdle }: { isReadOnly: boolean; isLive: boolean; isNativeIdle: boolean },
): string | null {
  if (isReadOnly) return "Read-only"
  if (!isLive) return null
  if (isNativeIdle) return "Running"
  return getStatusLabel(s.agentStatus, s.agentToolName, s.agentTerminalReason, s.agentPendingAgents) ?? "Running"
}

function dotStateFor(
  s: ActiveSessionInfo,
  { isDeferred, isLive }: { isDeferred: boolean; isLive: boolean },
): keyof typeof STATUS_DOT | null {
  if (isDeferred) return "attention"
  if (!isLive) return null
  return isIdleStatus(s.agentStatus) ? "idle" : "working"
}
