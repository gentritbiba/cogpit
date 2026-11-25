import type { ComposerCreated } from "@/lib/composerDraftIdentity"
import { useState, useCallback, useRef, type Dispatch } from "react"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import { nextLoadId, type SessionSource } from "@/lib/sessionSource"
import type { LoadedSession, SessionController } from "@/lib/sessionLoader"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../shared/session/sessionDigest"
import { AuthRequiredError, authFetch } from "@/lib/auth"
import { slugifyWorktreeName } from "@/lib/utils"
import { agentKindForDirName, descriptorFor, type AgentKind } from "@/lib/agents"
import { fetchWithModelFallback } from "@/lib/agents/modelFallback"
import { rename as renameSession } from "@/hooks/useSessionNames"
import { rememberStartPrompt } from "@/lib/startPrompts"
import { codeModeTerminalReady, codeModeTerminalStatus, startCodeModeSession, startsInCodeMode } from "@/lib/agents/codeMode"
import { getActiveDeviceScope } from "@/lib/device"
import { usePaneLifetime } from "@/contexts/DevicePaneContext"
import {
  learnListedAccess,
  rememberCreatedSession,
  sessionAccessTicket,
  type ListedSession,
} from "@/lib/sessionAccess"

interface UseNewSessionOpts {
  permissionsConfig: PermissionsConfig
  dispatch: Dispatch<SessionAction>
  sessions: SessionController
  isMobile: boolean
  onSessionFinalized: (parsed: SessionView, source: SessionSource) => void
  /** Called when the user sends the first message and session creation begins */
  onCreateStarted?: (message: string) => void
  onModelRejected?: (model: string) => void
  model: string
  effort: string
  contextWindowTokens?: number | null
  fastMode?: boolean
  ultracode?: boolean
  mcpConfig?: string | null
}

interface CreateSessionResponse {
  dirName: string
  fileName: string
  sessionId: string
  cwd?: string
}

interface SessionsListResponse {
  sessions?: Array<ListedSession & {
    fileName: string
    firstUserMessage?: string
    lastUserMessage?: string
    lastModified?: string
  }>
}

/** Derive a short session name from the first user message. */
function deriveSessionName(message: string): string {
  const cleaned = message.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").trim()
  if (!cleaned) return ""
  // Take first line, truncate to 60 chars
  const firstLine = cleaned.split("\n")[0].trim()
  if (firstLine.length <= 60) return firstLine
  return firstLine.slice(0, 57) + "..."
}

const EMPTY_SESSION_STATS = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 0,
  toolCallCounts: {},
  errorCount: 0,
  totalDurationMs: 0,
  turnCount: 0,
} as const

function buildEmptySession(response: CreateSessionResponse): SessionView {
  return {
    sessionId: response.sessionId,
    version: "",
    gitBranch: "",
    cwd: response.cwd ?? "",
    slug: "",
    name: "",
    model: "",
    turns: [],
    stats: { ...EMPTY_SESSION_STATS },
    digest: EMPTY_SESSION_DIGEST,
    agentKind: agentKindForDirName(response.dirName),
  }
}

/** A new session whose transcript is not readable yet; the live stream fills it in from the start. */
function emptyCreatedSession(response: CreateSessionResponse): LoadedSession {
  return {
    parsed: buildEmptySession(response),
    source: {
      dirName: response.dirName,
      fileName: response.fileName,
      agentKind: agentKindForDirName(response.dirName),
      watchOffset: 0,
      loadId: nextLoadId(),
    },
  }
}

/**
 * Whether a listed session can be the one this client just created. A server
 * that signs accounts in annotates each session with the caller's access and
 * also lists sessions shared with them, so only their own counts; a personal
 * server annotates nothing and lists only its own.
 */
function isOwnSession(session: Pick<ListedSession, "access">): boolean {
  return session.access ? session.access.mine : true
}

async function recoverCodexSession(
  dirName: string,
  message: string,
  startedAt: number,
  controller: AbortController
): Promise<CreateSessionResponse | null> {
  const accessTicket = sessionAccessTicket()
  const listRes = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}?page=1&limit=10`,
    { signal: controller.signal }
  )
  if (!listRes.ok) return null

  const data = await listRes.json() as SessionsListResponse
  learnListedAccess(data.sessions ?? [], accessTicket)
  const recentCutoff = startedAt - 30_000
  const normalizedMessage = message.trim()
  const candidates = (data.sessions ?? []).filter((session) => {
    const modified = session.lastModified ? new Date(session.lastModified).getTime() : 0
    return Number.isFinite(modified) && modified >= recentCutoff && isOwnSession(session)
  })

  const preferred = candidates.find((session) =>
    session.firstUserMessage?.trim() === normalizedMessage ||
    session.lastUserMessage?.trim() === normalizedMessage
  ) ?? candidates[0]

  if (!preferred) return null
  return {
    dirName,
    fileName: preferred.fileName,
    sessionId: preferred.sessionId,
  }
}

/** A project's folder, for a pending session that was opened without one. */
async function projectFolder(dirName: string, signal: AbortSignal): Promise<string | null> {
  const res = await authFetch("/api/projects", { signal })
  if (!res.ok) return null
  const projects = await res.json() as unknown
  if (!Array.isArray(projects)) return null
  const match = (projects as Array<{ dirName?: unknown; path?: unknown } | null>).find((project) => project?.dirName === dirName)
  return typeof match?.path === "string" && match.path ? match.path : null
}

type TranscriptAddress = Pick<CreateSessionResponse, "dirName" | "fileName">

const CODE_MODE_POLL_MS = 1000
/** How long one lookup may take, so a stalled request cannot outlast the deadlines below. */
const CODE_MODE_LOOKUP_MS = 5000
/** How long a terminal that never appeared is waited for: a refused spawn adds none. */
const CODE_MODE_SPAWN_MS = 15_000

/** Where the session's transcript is, "missing" until the CLI writes one, or "refused" when this caller may not see it or must sign in again. */
async function findSession(sessionId: string, signal: AbortSignal): Promise<{ address: TranscriptAddress } | "missing" | "refused"> {
  const lookup = new AbortController()
  const abort = () => lookup.abort()
  signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, CODE_MODE_LOOKUP_MS)
  try {
    const res = await authFetch(`/api/find-session/${encodeURIComponent(sessionId)}`, { signal: lookup.signal })
    if (res.ok) return { address: await res.json() as TranscriptAddress }
    return res.status === 401 || res.status === 403 ? "refused" : "missing"
  } catch (error) {
    return error instanceof AuthRequiredError ? "refused" : "missing"
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

type CodeModeFailure = "no_terminal" | "ended" | "refused"

/**
 * Where a Code Mode session's transcript is, once the CLI has written one: it
 * may first ask about the folder or the mode in the terminal, so a running
 * terminal is waited for without a deadline. Requests follow the active
 * machine connection (`scope`), so the wait pauses while another one is on
 * screen, and a terminal list that is not ready decides nothing. Null when the
 * wait is abandoned.
 */
async function waitForCodeModeTranscript(
  sessionId: string,
  scope: string,
  signal: AbortSignal,
): Promise<{ address: TranscriptAddress } | { failure: CodeModeFailure } | null> {
  const spawnedAt = Date.now()
  let started = false
  while (!signal.aborted) {
    if (getActiveDeviceScope() === scope) {
      // Read before the lookup too, so a transcript written just before the exit is still found.
      if (codeModeTerminalStatus(sessionId, scope) === "running") started = true
      const lookup = await findSession(sessionId, signal)
      if (lookup === "refused") return { failure: "refused" }
      if (lookup !== "missing" && getActiveDeviceScope() === scope) return lookup
      // Decide on the list as it is now, which the lookup may have outlasted.
      const terminal = codeModeTerminalStatus(sessionId, scope)
      if (terminal === "running") started = true
      if (terminal === "exited" || (terminal === null && started)) return { failure: "ended" }
      if (terminal === null && Date.now() - spawnedAt > CODE_MODE_SPAWN_MS) return { failure: "no_terminal" }
    }
    await new Promise((resolve) => setTimeout(resolve, CODE_MODE_POLL_MS))
  }
  return null
}

interface CodeModeStart {
  kind: AgentKind
  dirName: string
  cwd: string | null
  message: string
  images?: Array<{ data: string; mediaType: string }>
  worktree: boolean
  model: string
  effort: string
  permissions: PermissionsConfig
  signal: AbortSignal
}

/**
 * Start a session in Code Mode in the terminal panel of the machine on screen
 * when it was sent, and wait for its transcript. An error is for the user;
 * null means the start was abandoned.
 */
async function startInCodeMode(start: CodeModeStart): Promise<CreateSessionResponse | { error: string } | null> {
  const scope = getActiveDeviceScope()
  const { displayName } = descriptorFor(start.kind)
  const reconnecting = { error: "The terminal is reconnecting. Send it again in a moment." }
  if (start.images?.length) {
    return { error: "Code Mode sessions start in the terminal, which can't take attached images. Remove them, or paste them into the terminal once it starts." }
  }
  if (start.worktree) return { error: "Code Mode sessions can't start in a new worktree yet. Turn off Worktree to start one." }
  if (!codeModeTerminalReady(scope)) return reconnecting
  const cwd = start.cwd ?? await projectFolder(start.dirName, start.signal)
  if (start.signal.aborted) return null
  if (!cwd) return { error: "Couldn't find this project's folder to start Code Mode in." }
  if (getActiveDeviceScope() !== scope) return { error: "You switched machines before the session started. Send it again." }
  const sessionId = crypto.randomUUID()
  const launched = startCodeModeSession({
    kind: start.kind,
    sessionId,
    resume: false,
    cwd,
    prompt: start.message,
    model: start.model || undefined,
    effort: start.effort || undefined,
    permissions: start.permissions,
  }, scope)
  if (!launched) return reconnecting
  const wait = await waitForCodeModeTranscript(sessionId, scope, start.signal)
  if (!wait) return null
  if ("address" in wait) return { ...wait.address, sessionId, cwd }
  const errors: Record<CodeModeFailure, string> = {
    ended: `${displayName} ended before starting the session. Its output is in the terminal.`,
    no_terminal: `The terminal for ${displayName} didn't start.`,
    refused: "This server didn't let Cogpit open the new session.",
  }
  return { error: errors[wait.failure] }
}

export function useNewSession({
  permissionsConfig,
  dispatch,
  sessions,
  isMobile,
  onSessionFinalized,
  onCreateStarted,
  onModelRejected,
  model,
  effort,
  contextWindowTokens,
  fastMode,
  ultracode,
  mcpConfig,
}: UseNewSessionOpts) {
  const [creatingSession, setCreatingSession] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [worktreeEnabled, setWorktreeEnabled] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  /** A Code Mode start still waiting for its transcript, which a new draft must not be opened over. */
  const codeModeWaitRef = useRef<AbortController | null>(null)
  const paneLifetime = usePaneLifetime()
  /** The dirName of the pending session (set before first message) */
  const pendingDirNameRef = useRef<string | null>(null)
  /** The exact cwd selected for the pending session, when known. */
  const pendingCwdRef = useRef<string | null>(null)

  /** Instantly show the empty chat view for a new session (no backend call). */
  const handleNewSession = useCallback(
    (dirName: string, cwd?: string) => {
      codeModeWaitRef.current?.abort()
      pendingDirNameRef.current = dirName
      pendingCwdRef.current = cwd ?? null
      setCreateError(null)
      setCreatingSession(false)
      dispatch({ type: "INIT_PENDING_SESSION", dirName, cwd, isMobile })
    },
    [dispatch, isMobile]
  )

  /**
   * Create the session on the backend and send the first message.
   * Called from usePtyChat when the user submits their first message.
   * Returns the new sessionId on success.
   */
  const createAndSend = useCallback(
    async (
      message: string,
      images?: Array<{ data: string; mediaType: string }>,
      onCreated?: ComposerCreated,
    ): Promise<string | null> => {
      const dirName = pendingDirNameRef.current
      if (!dirName) return null
      const agentKind = agentKindForDirName(dirName)
      const cwd = pendingCwdRef.current

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setCreatingSession(true)
      setCreateError(null)
      onCreateStarted?.(message)
      const startedAt = Date.now()
      const sessionName = deriveSessionName(message)

      /** Show a session this client created, as its creator's own. */
      async function adoptCreatedSession(created: CreateSessionResponse): Promise<string> {
        pendingDirNameRef.current = null
        pendingCwdRef.current = null
        rememberCreatedSession(created.sessionId)
        rememberStartPrompt(created.sessionId, message)
        // A tail read through the worker, like every other open: its offset
        // is where the live stream picks up whatever the agent writes next.
        await sessions.openSession({ dirName: created.dirName, fileName: created.fileName }, {
          reason: "finalize",
          recover: () => emptyCreatedSession(created),
          commit: (loaded) => {
            const { parsed, source } = loaded.parsed.sessionId ? loaded : { ...loaded, parsed: buildEmptySession(created) }
            dispatch({ type: "FINALIZE_SESSION", session: parsed, source, isMobile })
            onCreated?.({ sessionId: parsed.sessionId, cwd: parsed.cwd, dirName: source.dirName })
            onSessionFinalized(parsed, source)
          },
        })
        // Auto-store the derived session name so it appears in sidebar/lists
        if (sessionName) renameSession(created.sessionId, sessionName)
        return created.sessionId
      }

      try {
        const descriptor = descriptorFor(agentKind)
        const { capabilities } = descriptor
        const worktreeName = capabilities.worktrees && worktreeEnabled ? slugifyWorktreeName(message) : undefined
        if (startsInCodeMode(agentKind, dirName)) {
          codeModeWaitRef.current = controller
          // A machine pane torn down for good takes its pending start with it.
          const forget = paneLifetime?.onEnd(() => controller.abort())
          const started = await startInCodeMode({
            kind: agentKind,
            dirName,
            cwd,
            message,
            images,
            worktree: capabilities.worktrees && worktreeEnabled,
            model,
            effort,
            permissions: permissionsConfig,
            signal: controller.signal,
          }).finally(() => {
            forget?.()
            if (codeModeWaitRef.current === controller) codeModeWaitRef.current = null
          })
          if (!started) return null
          if ("error" in started) {
            setCreateError(started.error)
            return null
          }
          return await adoptCreatedSession(started)
        }
        const requestBody = {
          dirName,
          // A lossy dirName cannot be decoded back to the cwd, so the server
          // has to be told it.
          cwd: descriptor.dirName.lossy ? (cwd ?? undefined) : undefined,
          message,
          images,
          permissions: permissionsConfig,
          effort: effort || undefined,
          contextWindowTokens,
          fastMode: fastMode ? true : undefined,
          ultracode: capabilities.ultracode && ultracode ? true : undefined,
          name: capabilities.namedSessions ? (sessionName || undefined) : undefined,
          worktreeName,
          mcpConfig: capabilities.mcp ? (mcpConfig || undefined) : undefined,
        }

        const { res, errorMessage, errorCode } = await fetchWithModelFallback(
          (modelOverride) => authFetch("/api/create-and-send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...requestBody, model: modelOverride }),
            signal: controller.signal,
          }),
          {
            model,
            agentKind,
            errorFallback: "Unknown error",
            onModelRejected,
          },
        )

        if (!res.ok) {
          // An unconfirmed start is one the server refused to hand over, so a
          // recent session of the caller's would be the wrong one.
          if (agentKind === "codex" && !worktreeEnabled && errorCode !== "SESSION_UNCONFIRMED") {
            const recovered = await recoverCodexSession(dirName, message, startedAt, controller)
            if (recovered) return await adoptCreatedSession(recovered)
          }
          setCreateError(errorMessage || `Failed to create session (${res.status})`)
          return null
        }

        return await adoptCreatedSession(await res.json() as CreateSessionResponse)
      } catch (err) {
        if (controller.signal.aborted) return null
        setCreateError(err instanceof Error ? err.message : "Failed to create session")
        return null
      } finally {
        if (!controller.signal.aborted) {
          setCreatingSession(false)
        }
      }
    },
    [permissionsConfig, model, effort, contextWindowTokens, fastMode, ultracode, mcpConfig, worktreeEnabled, paneLifetime, dispatch, sessions, isMobile, onSessionFinalized, onCreateStarted, onModelRejected]
  )

  const clearCreateError = useCallback(() => setCreateError(null), [])

  /** Abort any in-flight createAndSend request. Used when switching away
   *  from a pending session before creation completes. */
  const cancelCreation = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    pendingDirNameRef.current = null
    pendingCwdRef.current = null
    setCreatingSession(false)
    setCreateError(null)
  }, [])

  return {
    creatingSession,
    createError,
    clearCreateError,
    handleNewSession,
    createAndSend,
    cancelCreation,
    worktreeEnabled,
    setWorktreeEnabled,
  }
}
