import { useSyncExternalStore } from "react"

import { descriptorFor, type AgentKind, type PermissionsConfig } from "../../../shared/session/agent-descriptors"
import { splitInstanceDirName, splitInstanceSessionId } from "../../../shared/session/instances"
import { getCurrentUser } from "@/lib/capabilities"
import { deviceScope, deviceScopedKey, getActiveDeviceId, getActiveDeviceScope } from "@/lib/device"
import { useDeviceId, useDeviceScopedKey } from "@/contexts/DevicePaneContext"

/**
 * Code Mode runs only in an agent CLI's own interactive terminal. With the
 * setting on, Cogpit starts new sessions there, in the terminal panel, and
 * follows their transcripts instead of driving them. Each machine's terminal
 * panel registers itself as the runner for that machine's current connection
 * (its device scope) while it is on screen.
 */

/** A session to run in Code Mode, as the terminal panel starts it. */
export interface CodeModeLaunch {
  kind: AgentKind
  sessionId: string
  /** Continue the session instead of starting it. */
  resume: boolean
  cwd: string
  prompt?: string
  model?: string
  effort?: string
  permissions?: PermissionsConfig
}

/** A session's terminal: none yet, running, ended, or unknown while the panel is not connected. */
export type CodeModeTerminalStatus = "running" | "exited" | null | "unavailable"

export interface CodeModeRunner {
  /** Whether the panel's terminal connection is up and has listed its terminals, so a launch reaches it and a status is current. */
  readonly ready: boolean
  start(launch: CodeModeLaunch): void
  /** Bring a session's running terminal forward; false when none is running. */
  show(sessionId: string): boolean
  /** The state of the terminal running a session; null when there is none yet. */
  status(sessionId: string): Exclude<CodeModeTerminalStatus, "unavailable">
}

/** Each machine's setting; null for a server too old to know Code Mode, which cannot start or resume one. */
const settings = new Map<string, boolean | null>()
/** Runners by device scope: a machine reconnected to another host is a different scope. */
const runners = new Map<string, CodeModeRunner>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Called by useAppConfig whenever a machine's /api/config resolves. */
export function setCodeModeEnabled(deviceId: string, next: boolean | null): void {
  settings.set(deviceId, next)
}

function defaultAccount(sessionId: string): boolean {
  try {
    return splitInstanceSessionId(sessionId).instanceId === "default"
  } catch {
    return false
  }
}

/**
 * Whether the active machine runs `kind` in Code Mode at all: the agent has
 * it, and the server knows Code Mode and leaves each session to one owner. A
 * server that controls ownership refuses terminal launches, which would go
 * around it.
 */
function codeModeOffered(kind: AgentKind): boolean {
  return descriptorFor(kind).cli.codeMode !== null
    && typeof settings.get(getActiveDeviceId()) === "boolean"
    && getCurrentUser().enforcesSessionAccess === false
}

/**
 * Whether a session can run in Code Mode on the active machine: it is offered
 * there, and the session is the default account's. The terminal starts from
 * the server's own environment, so a provider-account instance would run with
 * the wrong credentials.
 */
export function codeModeAvailable(kind: AgentKind, sessionId: string): boolean {
  return codeModeOffered(kind) && defaultAccount(sessionId)
}

/** Whether a new session in project `dirName` is meant for Code Mode: the setting is on for the active machine, whose terminal panel can run one. */
export function startsInCodeMode(kind: AgentKind, dirName: string): boolean {
  return settings.get(getActiveDeviceId()) === true
    && runners.has(getActiveDeviceScope())
    && splitInstanceDirName(dirName).instanceId === "default"
    && codeModeOffered(kind)
}

export function registerCodeModeRunner(deviceId: string, next: CodeModeRunner): () => void {
  const scope = deviceScope(deviceId)
  runners.set(scope, next)
  notify()
  return () => {
    if (runners.get(scope) !== next) return
    runners.delete(scope)
    notify()
  }
}

function readyRunner(scope: string): CodeModeRunner | null {
  const runner = runners.get(scope)
  return runner?.ready ? runner : null
}

/** Whether a machine connection's terminal panel is ready, so a Code Mode session can start there. */
export function codeModeTerminalReady(scope = getActiveDeviceScope()): boolean {
  return readyRunner(scope) !== null
}

/** Whether this pane's machine has a ready terminal panel to run Code Mode in. */
export function useCanRunCodeMode(): boolean {
  const scope = deviceScope(useDeviceId())
  return useSyncExternalStore(subscribe, () => readyRunner(scope) !== null, () => false)
}

/** Open a terminal running the session in Code Mode; false when that machine connection has no ready terminal panel. */
export function startCodeModeSession(launch: CodeModeLaunch, scope = getActiveDeviceScope()): boolean {
  const runner = readyRunner(scope)
  if (!runner || !codeModeAvailable(launch.kind, launch.sessionId)) return false
  rememberCodeModeSession(launch.sessionId)
  runner.start(launch)
  return true
}

/** Continue a session in Code Mode in the terminal panel; false when there is no terminal to do it in. */
export function resumeInCodeMode(kind: AgentKind, sessionId: string, cwd: string): boolean {
  return startCodeModeSession({ kind, sessionId, resume: true, cwd })
}

export function showCodeModeTerminal(sessionId: string): boolean {
  return readyRunner(getActiveDeviceScope())?.show(sessionId) ?? false
}

export function codeModeTerminalStatus(sessionId: string, scope = getActiveDeviceScope()): CodeModeTerminalStatus {
  const runner = readyRunner(scope)
  return runner ? runner.status(sessionId) : "unavailable"
}

// ── Sessions started in Code Mode ───────────────────────────────────────────
//
// The CLI refuses to continue such a session anywhere but its own terminal, so
// the composer offers that terminal instead. Remembered per device, newest last.

const REMEMBERED_LIMIT = 500
const REMEMBERED_KEY = "cogpit:code-mode-sessions"

function readRemembered(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

const remembered = new Map<string, ReadonlySet<string>>()

function rememberedIds(key: string): ReadonlySet<string> {
  let ids = remembered.get(key)
  if (!ids) {
    ids = new Set(readRemembered(key))
    remembered.set(key, ids)
  }
  return ids
}

/** Remember a session of a machine, by default the active one an event handler acts for. */
export function rememberCodeModeSession(sessionId: string, deviceId = getActiveDeviceId()): void {
  const key = deviceScopedKey(REMEMBERED_KEY, deviceId)
  if (rememberedIds(key).has(sessionId)) return
  const ids = [...readRemembered(key).filter((id) => id !== sessionId), sessionId].slice(-REMEMBERED_LIMIT)
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // Storage full or unavailable: remembered for this page only.
  }
  remembered.set(key, new Set(ids))
  notify()
}

/** Whether this pane's machine started `sessionId` in Code Mode, or learned it was. */
export function useIsCodeModeSession(sessionId: string | null | undefined): boolean {
  const key = useDeviceScopedKey(REMEMBERED_KEY)
  return useSyncExternalStore(subscribe, () => Boolean(sessionId && rememberedIds(key).has(sessionId)), () => false)
}
