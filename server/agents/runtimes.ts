import { acpRuntime } from "./acpRuntime"
import {
  AGENT_KINDS,
  descriptorForDirName,
  type AgentKind,
} from "../../shared/session/agent-descriptors"
import { persistentSessions } from "../processRegistry"
import { findJsonlPath } from "../sessionPaths"
import { storeForPath } from "./index"
import { claudeRuntime } from "./claudeRuntime"
import { codexRuntime } from "./codexRuntime"
import { copilotRuntime } from "./copilotRuntime"
import { instanceRuntimes } from "./instanceRuntimes"
import { splitInstanceSessionId, splitInstanceDirName } from "../../shared/session/instances"
import { AgentRuntimeError } from "./runtimeTypes"
import type { AgentRuntime } from "./runtimeTypes"

/**
 * The server-side runtime registry: one `AgentRuntime` per CLI, plus the
 * resolvers that pick one from a kind, a dirName or a live session id.
 *
 * Kept out of `./index` deliberately. The stores there are leaves — the
 * runtimes reach back into `../sessionPaths` and `./codexExecution`, which
 * read the store registry, and `scripts/check-architecture.ts` counts even a
 * type-only import as a graph edge before running Tarjan. Routes import stores
 * from `./index` and runtimes from here.
 */

export type {
  AcceptedAnswer,
  AgentPermissions,
  AgentRuntime,
  ApprovalDecision,
  ImageAttachment,
  PendingApproval,
  PendingQuestion,
  ResolvedApproval,
  SendOutcome,
  SendRequest,
  StartSessionRequest,
  StartedSession,
  StopAllResult,
  TurnResult,
  UserQuestionAnswers,
} from "./runtimeTypes"
export { AgentRuntimeError, selectAvailableDecision } from "./runtimeTypes"

const RUNTIMES: Readonly<Record<AgentKind, AgentRuntime>> = Object.freeze({
  claude: claudeRuntime,
  codex: codexRuntime,
  copilot: copilotRuntime,
  acp: acpRuntime,
})

export function runtimeFor(kind: AgentKind, instanceId = "default"): AgentRuntime {
  if (instanceId !== "default") {
    const runtime = instanceRuntimes().find((runtime) => runtime.instanceId === instanceId && runtime.kind === kind)
    if (!runtime) throw new AgentRuntimeError(404, "INSTANCE_NOT_FOUND", "Provider instance not found")
    return runtime
  }
  return RUNTIMES[kind]
}

/** The runtime owning a project dirName. Claude is the terminal arm. */
export function runtimeForDirName(dirName: string | null | undefined): AgentRuntime {
  return runtimeFor(descriptorForDirName(dirName).kind, splitInstanceDirName(dirName).instanceId)
}

/**
 * The runtime actually holding this session, asked rather than guessed.
 *
 * The old code walked a fixed agent precedence and took whichever answered
 * first with a non-empty list, so a session that was live but idle handed the
 * id to the next agent in line. Ownership is what decides here.
 */
export function runtimeForSession(sessionId: string): AgentRuntime | null {
  const owners = allRuntimes().filter((runtime) => runtime.hasSession(sessionId))
  if (owners.length > 1) throw new AgentRuntimeError(409, "AMBIGUOUS_SESSION", "Use the provider instance's scoped session ID")
  return owners[0] ?? null
}

/** Every runtime, in agent-detection order. */
export function allRuntimes(): readonly AgentRuntime[] {
  return [...AGENT_KINDS.map((kind) => RUNTIMES[kind]), ...instanceRuntimes()]
}

/** Whether any runtime still holds this session, open or mid-turn. */
export function isSessionActive(sessionId: string): boolean {
  return allRuntimes().some((runtime) => {
    const activity = runtime.activity(sessionId)
    return activity.live || activity.running
  })
}

/**
 * The agents that keep a connection per session, so membership is a complete
 * answer. Claude is absent on purpose: its resume path needs the transcript
 * path anyway, so short-circuiting the lookup would save nothing.
 */
const LIVE_CONNECTION_KINDS: readonly AgentKind[] = ["copilot", "codex"]

export interface ResolvedSessionAgent {
  kind: AgentKind
  instanceId?: string
  /** The session's transcript, when one was found without extra work. */
  filePath: string | null
}

/**
 * Which agent owns a session id, and where its transcript is.
 *
 * A live Copilot session short-circuits the filesystem lookup on purpose: one
 * headless CLI serves every Copilot session, so "is it open?" is already a
 * complete answer, and paying for a walk of three session trees on every send
 * would be pure waste. A legacy CLI child records its own kind. Everything else
 * is decided by whose storage the transcript sits in — and by Claude when there
 * is no transcript at all, because an unknown id still has to resolve to
 * something, and attempting a resume beats a 404.
 */
export async function resolveSessionAgent(sessionId: string): Promise<ResolvedSessionAgent> {
  const scoped = splitInstanceSessionId(sessionId)
  if (scoped.instanceId !== "default") {
    const filePath = await findJsonlPath(sessionId)
    const store = storeForPath(filePath)
    const runtime = instanceRuntimes().find((runtime) => runtime.instanceId === scoped.instanceId)
    if (!runtime || (store && store.kind !== runtime.kind)) throw new AgentRuntimeError(404, "INSTANCE_NOT_FOUND", "Provider instance not found")
    return { kind: runtime.kind, instanceId: scoped.instanceId, filePath }
  }
  const legacy = persistentSessions.get(sessionId)
  if (!legacy) {
    // An agent holding a live connection already knows the id, for free and
    // before any file is read. It answers without a transcript path because
    // nothing it can do with a live session needs one: a message that joins a
    // running turn carries its own settings, and stopping one is a signal.
    for (const kind of LIVE_CONNECTION_KINDS) {
      if (runtimeFor(kind).hasSession(sessionId)) return { kind, filePath: null }
    }
  }
  const filePath = legacy?.jsonlPath ?? await findJsonlPath(sessionId)
  return {
    kind: legacy?.agentKind ?? storeForPath(filePath)?.kind ?? "claude",
    filePath,
  }
}
