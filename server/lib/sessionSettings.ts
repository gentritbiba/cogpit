import type { IncomingMessage } from "node:http"
import type { SessionSettingField } from "../../shared/contracts/sessionSettings"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import type { AgentTurnSettings, SendRequest } from "../agents/runtimeTypes"
import { editionModule, type ActivitySessionRef } from "../edition"
import { readTranscriptEffort } from "../helpers"
import { findJsonlPath } from "../sessionPaths"
import { readSessionConfig, sessionConfigKey, updateSessionConfig, type SessionConfig } from "./sessionConfigStore"
import * as streamBus from "./streamBus"

/**
 * A session's stored config as the account of the settings its turns run
 * with. A send that leaves out the permission mode runs with the stored one in
 * every edition; clients send a mode only when their user picked it. Beyond
 * that personal edition leaves a send's settings as they came, and an edition
 * may hold them to the stored settings (`EditionSessionSettings`).
 */

/**
 * `PUT /api/session-config/:key`: merge the patch into the key's config, or
 * with `fill` only its fields the config holds no value for. The edition hears
 * of a write to a session's own key that moved a field.
 */
export async function writeSessionConfig(
  req: IncomingMessage,
  key: string,
  sessionId: string | null,
  patch: SessionConfig,
  { fill = false }: { fill?: boolean } = {},
): Promise<SessionConfig> {
  const update = await updateSessionConfig(key, (stored) => (
    fill ? Object.fromEntries(Object.entries(patch).filter(([field]) => stored[field] === undefined)) : patch
  ))
  if (sessionId !== null && update.changed.length > 0) {
    await editionModule().sessionSettings.onConfigWrite(req, sessionId, update)
  }
  return update.config
}

/** The request with the stored permission mode, when it carries none of its own. */
function withStoredMode<T extends AgentTurnSettings>(request: T, config: SessionConfig): T {
  if (typeof config.permissionMode !== "string") return request
  return { ...request, permissions: { ...request.permissions, mode: config.permissionMode } }
}

/**
 * The effort a session runs at: the stored choice, else the one its transcript
 * last recorded. An empty stored effort means "provider default", not a choice.
 */
export async function sessionEffort(sessionId: string, config?: SessionConfig): Promise<string | null> {
  const stored = (config ?? await readSessionConfig(sessionConfigKey(sessionId))).effort
  if (typeof stored === "string" && stored) return stored
  try {
    const filePath = await findJsonlPath(sessionId)
    return filePath ? await readTranscriptEffort(filePath) : null
  } catch {
    return null
  }
}

/**
 * A send from outside the composer, run with the session's stored permission
 * mode and effort where it names none. Only stored values, so a retried durable
 * command carries the same content as the first attempt.
 */
export async function withSessionSettings(sessionId: string, request: SendRequest): Promise<SendRequest> {
  const config = await readSessionConfig(sessionConfigKey(sessionId))
  const moded = request.permissions?.mode === undefined ? withStoredMode(request, config) : request
  return moded.effort === undefined && typeof config.effort === "string" && config.effort ? { ...moded, effort: config.effort } : moded
}

/**
 * Keep the mode and effort a session started with, so a later resume that
 * names none runs the same way, without replacing what a client stored first.
 * Anyone already watching the session reads its config again.
 */
export async function storeStartedSettings(sessionId: string, { mode, effort }: { mode?: string; effort?: string }): Promise<void> {
  if (!mode && !effort) return
  const { changed } = await updateSessionConfig(sessionConfigKey(sessionId), (stored) => ({
    ...(mode && stored.permissionMode === undefined ? { permissionMode: mode } : {}),
    ...(effort && stored.effort === undefined ? { effort } : {}),
  }))
  if (changed.length > 0) streamBus.publishSessionConfig(sessionId)
}

/**
 * The settings a send runs with: as the edition settles them, the fields it
 * names in `changes` being the ones it sets anew, and with the stored
 * permission mode when it still carries none.
 */
export async function settleTurnSettings<T extends AgentTurnSettings>(
  req: IncomingMessage,
  session: ActivitySessionRef,
  request: T,
  changes: readonly SessionSettingField[],
): Promise<T> {
  const settled = await editionModule().sessionSettings.settleTurn(req, session, request, changes)
  if (settled.permissions?.mode !== undefined) return settled
  return withStoredMode(settled, await readSessionConfig(sessionConfigKey(session.sessionId)))
}

/** The part of a live settings update the running session applies; what is not a session setting always is. */
export function heldLiveUpdate<T extends object>(updates: T, changes: readonly SessionSettingField[]): T {
  return editionModule().sessionSettings.holdLiveUpdate(updates, changes)
}

/** A settings change applied to a running session outside a send, through its runtime's live update. */
export function storeAppliedSettings(
  req: IncomingMessage,
  sessionId: string,
  agent: AgentKind | null,
  applied: AgentTurnSettings,
): Promise<void> {
  return editionModule().sessionSettings.storeApplied(req, sessionId, agent, applied)
}
