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
  AgentPermissions,
  AgentRuntime,
  ApprovalBatchResult,
  ApprovalDecision,
  ImageAttachment,
  PendingApproval,
  PendingQuestion,
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
})

export interface RuntimeRegistry {
  runtimeFor(kind: AgentKind): AgentRuntime
  runtimeForDirName(dirName: string | null | undefined): AgentRuntime
  runtimeForSession(sessionId: string): AgentRuntime | null
  allRuntimes(): readonly AgentRuntime[]
}

/**
 * Build resolvers over an arbitrary runtime table. The module-level singletons
 * below are this applied to the real table; tests inject a fake one.
 */
export function createRuntimeRegistry(
  runtimes: Readonly<Record<AgentKind, AgentRuntime>>,
): RuntimeRegistry {
  return {
    runtimeFor: (kind) => runtimes[kind],
    runtimeForDirName: (dirName) => runtimes[descriptorForDirName(dirName).kind],
    /**
     * The runtime actually holding this session, asked rather than guessed.
     *
     * The old code walked a fixed agent precedence and took whichever answered
     * first with a non-empty list, so a session that was live but idle handed
     * the id to the next agent in line. Ownership is what decides here.
     */
    runtimeForSession(sessionId) {
      for (const kind of AGENT_KINDS) {
        if (runtimes[kind].hasSession(sessionId)) return runtimes[kind]
      }
      return null
    },
    allRuntimes: () => AGENT_KINDS.map((kind) => runtimes[kind]),
  }
}

const registry = createRuntimeRegistry(RUNTIMES)

export function runtimeFor(kind: AgentKind): AgentRuntime {
  return registry.runtimeFor(kind)
}

/** The runtime owning a project dirName. Claude is the terminal arm. */
export function runtimeForDirName(dirName: string | null | undefined): AgentRuntime {
  return registry.runtimeForDirName(dirName)
}

/** The runtime holding live state for a session id, or null when none does. */
export function runtimeForSession(sessionId: string): AgentRuntime | null {
  return registry.runtimeForSession(sessionId)
}

/** Every runtime, in agent-detection order. */
export function allRuntimes(): readonly AgentRuntime[] {
  return registry.allRuntimes()
}

/**
 * The agents that keep a connection per session, so membership is a complete
 * answer. Claude is absent on purpose: its resume path needs the transcript
 * path anyway, so short-circuiting the lookup would save nothing.
 */
const LIVE_CONNECTION_KINDS: readonly AgentKind[] = ["copilot", "codex"]

export interface ResolvedSessionAgent {
  kind: AgentKind
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
