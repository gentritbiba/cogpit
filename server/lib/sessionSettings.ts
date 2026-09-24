import type { IncomingMessage } from "node:http"
import type { SessionSettingField } from "../../shared/contracts/sessionSettings"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import type { AgentTurnSettings } from "../agents/runtimeTypes"
import { editionModule, type ActivitySessionRef } from "../edition"
import { readSessionConfig, sessionConfigKey, updateSessionConfig, type SessionConfig } from "./sessionConfigStore"

/**
 * A session's stored config as the account of the settings its turns run
 * with. A send that leaves out the permission mode runs with the stored one in
 * every edition; clients send a mode only when their user picked it. Beyond
 * that personal edition leaves a send's settings as they came, and an edition
 * may hold them to the stored settings (`EditionSessionSettings`).
 */

/**
 * `PUT /api/session-config/:key`: merge the patch into the key's config. The
 * edition hears of a write to a session's own key that moved a field.
 */
export async function writeSessionConfig(
  req: IncomingMessage,
  key: string,
  sessionId: string | null,
  patch: SessionConfig,
): Promise<SessionConfig> {
  const update = await updateSessionConfig(key, () => patch)
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
