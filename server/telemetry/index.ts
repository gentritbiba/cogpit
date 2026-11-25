import type { IncomingMessage } from "node:http"
import { publicModelName } from "../agents/publicModels"
import type { AgentRuntime, SendOutcome, SendRequest, StartedSession, StartSessionRequest } from "../agents/runtimeTypes"
import { commonProperties, telemetryEnabled, type TelemetryDistribution, type TelemetryShell } from "./context"
import { TelemetryDelivery } from "./delivery"
import {
  clientSurface,
  sanitizeProperties,
  settingToken,
  type TelemetryEventName,
  type TelemetryEvents,
  type TelemetryProperties,
} from "./events"
import { initialState, pruneSessions, readState, writeState, type TelemetryState } from "./state"
import { finishedTurns, type ReadSessionTurns } from "./turns"
import { daysToReport, usageEvents, utcDay, type ReadDailyUsage } from "./usage"

/**
 * Anonymous usage data. The server records every event, for the desktop app,
 * browsers, phones and agents alike, and sends them to Cogpit's own endpoint,
 * which adds a coarse location from the request and forwards them on. Nothing
 * runs or is written while it is off. See docs/telemetry.md for what is sent
 * and how to turn it off.
 */

export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.cogpit.dev/v1/batch"

const DAY_MS = 24 * 60 * 60 * 1000
const FLUSH_INTERVAL_MS = 10_000
const USAGE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const TURN_CHECK_INTERVAL_MS = 5 * 60 * 1000
/** Turns are looked for in sessions Cogpit drove this recently. */
const TURN_SESSION_WINDOW_MS = 2 * DAY_MS
/** The first checks wait until start-up work has settled. */
const FIRST_CHECK_MS = 2 * 60 * 1000
const SHUTDOWN_FLUSH_MS = 1_000
const STATE_SAVE_DELAY_MS = 30_000

export interface TelemetryOptions {
  dataDir: string
  shell: TelemetryShell
  distribution: TelemetryDistribution
  edition: string
  freshInstall: boolean
  /** A development build, which would count as an install of its own. */
  development: boolean
  defaultAgent?: string
  /** Reads one UTC day of usage for the given sessions; passed in so this module stays a leaf. */
  readDailyUsage: ReadDailyUsage
  readSessionTurns?: ReadSessionTurns
  readAgentStatus?: () => Promise<TelemetryEvents["agent.status"][]>
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
}

interface Running {
  options: TelemetryOptions
  state: TelemetryState
  common: TelemetryProperties
  delivery: TelemetryDelivery
  timers: ReturnType<typeof setInterval | typeof setTimeout>[]
  saveTimer: ReturnType<typeof setTimeout> | null
  saving: Promise<void>
  checkingUsage: Promise<void> | null
  checkingTurns: Promise<void> | null
  /** Transcript times already read, so an unchanged session is not parsed again. */
  transcriptTimes: Map<string, number>
  now: () => number
}

let running: Running | null = null

function save(run: Running): Promise<void> {
  if (run.saveTimer) clearTimeout(run.saveTimer)
  run.saveTimer = null
  const sessions = pruneSessions(run.state.sessions, run.now())
  const turns = Object.fromEntries(Object.entries(run.state.turns).filter(([id]) => Object.hasOwn(sessions, id)))
  run.state = { ...run.state, sessions, turns }
  const state = run.state
  run.saving = run.saving.then(() => writeState(run.options.dataDir, state)).catch((error: unknown) => {
    console.warn(`[telemetry] Could not save its state: ${error instanceof Error ? error.message : String(error)}`)
  })
  return run.saving
}

function saveSoon(run: Running): void {
  run.saveTimer ??= setTimeout(() => { void save(run) }, STATE_SAVE_DELAY_MS)
  run.saveTimer.unref?.()
}

function enqueue(run: Running, event: string, properties: object, timestamp?: Date): void {
  run.delivery.enqueue(event, { ...run.common, ...sanitizeProperties(properties) }, timestamp)
}

/** Record one event, when this server sends usage data. */
export function recordTelemetry<E extends TelemetryEventName>(event: E, properties: TelemetryEvents[E]): void {
  if (running) enqueue(running, event, properties)
}

function heartbeat(run: Running, reason: "start" | "daily"): void {
  enqueue(run, "app.heartbeat", {
    reason,
    freshInstall: run.options.freshInstall,
    ...(run.options.defaultAgent ? { defaultAgent: run.options.defaultAgent } : {}),
  } satisfies TelemetryEvents["app.heartbeat"])
}

async function reportAgentStatus(run: Running): Promise<void> {
  const statuses = await run.options.readAgentStatus?.().catch(() => [])
  if (running !== run) return
  for (const status of statuses ?? []) enqueue(run, "agent.status", status)
}

async function reportUsage(run: Running): Promise<void> {
  const now = run.now()
  if (!run.state.usageReportedThrough) {
    // Counting starts today: usage from before this install sent anything is never reported.
    run.state.usageReportedThrough = utcDay(now - DAY_MS)
    await save(run)
    return
  }
  const days = daysToReport(run.state.usageReportedThrough, now)
  if (days.length === 0) return
  const sessionIds = new Set(Object.keys(run.state.sessions))
  for (const day of days) {
    if (sessionIds.size > 0) {
      const summary = await run.options.readDailyUsage(day, sessionIds)
      if (running !== run) return
      const timestamp = new Date(`${day}T23:59:59.000Z`)
      for (const event of usageEvents(day, summary)) enqueue(run, "usage.daily", event, timestamp)
    }
    run.state.usageReportedThrough = day
  }
  await save(run)
}

async function reportTurns(run: Running): Promise<void> {
  const read = run.options.readSessionTurns
  if (!read) return
  const now = run.now()
  let changed = false
  for (const [sessionId, seen] of Object.entries(run.state.sessions)) {
    if (now - seen > TURN_SESSION_WINDOW_MS) continue
    const reportedThrough = run.state.turns[sessionId]
    if (reportedThrough === undefined) {
      // Noted before turns were counted: only turns from now on are reported.
      run.state.turns[sessionId] = now
      changed = true
      continue
    }
    const session = await read(sessionId, run.transcriptTimes.get(sessionId))
    if (running !== run) return
    if (!session) continue
    run.transcriptTimes.set(sessionId, session.mtimeMs)
    for (const finished of finishedTurns(session, reportedThrough)) {
      run.state.turns[sessionId] = Math.max(run.state.turns[sessionId] ?? 0, finished.startedAt)
      changed = true
      // The endpoint refuses a batch holding anything this old.
      if (now - finished.startedAt > TURN_SESSION_WINDOW_MS + DAY_MS) continue
      const timestamp = new Date(finished.startedAt)
      enqueue(run, "turn.completed", finished.turn, timestamp)
      for (const tool of finished.tools) enqueue(run, "tool.used", tool, timestamp)
    }
  }
  for (const sessionId of run.transcriptTimes.keys()) {
    if (!Object.hasOwn(run.state.sessions, sessionId)) run.transcriptTimes.delete(sessionId)
  }
  if (changed) saveSoon(run)
}

function checkTurns(run: Running): Promise<void> {
  run.checkingTurns ??= reportTurns(run)
    .catch((error: unknown) => {
      console.warn(`[telemetry] Could not read turns: ${error instanceof Error ? error.message : String(error)}`)
    })
    .finally(() => { run.checkingTurns = null })
  return run.checkingTurns
}

function checkUsage(run: Running): Promise<void> {
  run.checkingUsage ??= reportUsage(run)
    .catch((error: unknown) => {
      console.warn(`[telemetry] Could not read usage: ${error instanceof Error ? error.message : String(error)}`)
    })
    .finally(() => { run.checkingUsage = null })
  return run.checkingUsage
}

function schedule(run: Running): void {
  const every = (ms: number, task: () => void) => {
    const timer = setInterval(task, ms)
    timer.unref?.()
    run.timers.push(timer)
  }
  every(FLUSH_INTERVAL_MS, () => { void run.delivery.flushWhenDue() })
  every(DAY_MS, () => {
    heartbeat(run, "daily")
    void reportAgentStatus(run)
  })
  every(USAGE_CHECK_INTERVAL_MS, () => { void checkUsage(run) })
  every(TURN_CHECK_INTERVAL_MS, () => { void checkTurns(run) })
  const first = setTimeout(() => {
    void checkUsage(run)
    void reportAgentStatus(run)
  }, FIRST_CHECK_MS)
  first.unref?.()
  run.timers.push(first)
}

/** Begin sending, unless the environment or a development build keeps it off. */
export async function startTelemetry(options: TelemetryOptions): Promise<void> {
  await stopTelemetry()
  const env = options.env ?? process.env
  if (!telemetryEnabled(env, options.development)) return
  const stored = await readState(options.dataDir)
  const state = stored ?? initialState()
  const now = options.now ?? Date.now
  const run: Running = {
    options,
    state,
    common: commonProperties({ shell: options.shell, distribution: options.distribution, edition: options.edition, env }),
    delivery: new TelemetryDelivery({
      endpoint: env.COGPIT_TELEMETRY_URL || DEFAULT_TELEMETRY_ENDPOINT,
      installId: state.installId,
      fetch: options.fetch ?? fetch,
      now,
    }),
    timers: [],
    saveTimer: null,
    saving: Promise.resolve(),
    checkingUsage: null,
    checkingTurns: null,
    transcriptTimes: new Map(),
    now,
  }
  running = run
  if (!stored) await save(run)
  schedule(run)
  heartbeat(run, "start")
}

/** Send what is still queued, briefly, and stop. */
export async function stopTelemetry(): Promise<void> {
  const run = running
  if (!run) return
  running = null
  for (const timer of run.timers) clearTimeout(timer)
  await Promise.race([
    run.delivery.flush(),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_MS).unref?.()),
  ])
  await save(run)
}

/** Remember a session Cogpit drives, so its usage can be counted. */
function noteSession(run: Running, sessionId: string): void {
  const now = run.now()
  const seen = run.state.sessions[sessionId]
  if (seen === undefined || now - seen > TURN_SESSION_WINDOW_MS || run.state.turns[sessionId] === undefined) {
    // The turn this starts begins after now; a second back allows for clock rounding.
    run.state.turns[sessionId] = now - 1_000
  }
  run.state.sessions[sessionId] = now
  saveSoon(run)
}

function turnProperties(req: IncomingMessage | undefined, runtime: AgentRuntime, request: { model?: string; effort?: string; fastMode?: boolean; permissions?: { mode?: string } }) {
  const model = publicModelName(request.model)
  const effort = settingToken(request.effort)
  const permissionMode = settingToken(request.permissions?.mode)
  return {
    agent: runtime.kind,
    instance: (runtime.instanceId ?? "default") !== "default",
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(request.fastMode !== undefined ? { fastMode: request.fastMode } : {}),
    client: clientSurface(req),
  }
}

export function recordSessionStarted(req: IncomingMessage | undefined, runtime: AgentRuntime, request: StartSessionRequest, started: StartedSession): void {
  const run = running
  if (!run) return
  noteSession(run, started.sessionId)
  const properties = turnProperties(req, runtime, { ...request, permissions: { mode: started.permissionMode ?? request.permissions?.mode } })
  enqueue(run, "session.started", { ...properties, worktree: Boolean(request.worktreeName) } satisfies TelemetryEvents["session.started"])
}

export function recordMessageSent(req: IncomingMessage | undefined, runtime: AgentRuntime, sessionId: string, request: SendRequest, outcome: SendOutcome, route: string): void {
  const run = running
  if (!run || outcome.delivery === "busy") return
  noteSession(run, sessionId)
  enqueue(run, "message.sent", {
    ...turnProperties(req, runtime, request),
    delivery: outcome.delivery,
    route,
  } satisfies TelemetryEvents["message.sent"])
}

/** For tests: run the usage check now and wait for every pending save. */
export async function __checkUsageForTest(): Promise<void> {
  const run = running
  if (!run) return
  await checkUsage(run)
  await save(run)
}

/** For tests: look for finished turns and agent status now. */
export async function __checkTurnsForTest(): Promise<void> {
  const run = running
  if (!run) return
  await Promise.all([checkTurns(run), reportAgentStatus(run)])
}

/** For tests: send what is queued now. */
export async function __flushTelemetryForTest(): Promise<void> {
  await running?.delivery.flush()
}
