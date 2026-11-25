import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { AGENT_KINDS, descriptorFor, type AgentDescriptor, type AgentKind, type PermissionsConfig } from "../../shared/session/agent-descriptors"
import { cogpitAgentEnv } from "../browser/agentEnv"
import { expandHome, getConfig } from "../config"
import { AgentRuntimeError } from "./runtimeTypes"
import { spawnedExecutableFor } from "./executables"
import { agentTerminalLaunch, type AgentTerminalLaunch } from "./terminalLaunch"

/** A session the terminal panel asks to run in an agent's Code Mode. */
export interface CodeModeRequest {
  agent: AgentKind
  sessionId: string
  /** Continue the session instead of starting it. */
  resume: boolean
  prompt?: string
  model?: string
  effort?: string
  permissions?: PermissionsConfig
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A flag's value: a string a CLI cannot mistake for another flag. */
function flagValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.startsWith("-") ? value : undefined
}

function toolList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((tool): tool is string => typeof tool === "string" && !tool.startsWith("-")) : undefined
}

function permissionsFrom(value: unknown): PermissionsConfig | undefined {
  if (!value || typeof value !== "object") return undefined
  const { mode, allowedTools, disallowedTools } = value as Record<string, unknown>
  return { mode: flagValue(mode), allowedTools: toolList(allowedTools), disallowedTools: toolList(disallowedTools) }
}

/**
 * The `codeMode` field of a spawn message, when it names an agent with Code
 * Mode and a session of the default account. A provider-account instance's
 * session is refused: the terminal inherits the server's environment, whose
 * credentials it cannot drop, so it would run under the wrong account.
 */
export function codeModeRequest(value: unknown): CodeModeRequest | null {
  if (!value || typeof value !== "object") return null
  const fields = value as Record<string, unknown>
  const agent = fields.agent
  if (typeof agent !== "string" || !(AGENT_KINDS as readonly string[]).includes(agent)) return null
  if (!descriptorFor(agent as AgentKind).cli.codeMode) return null
  if (typeof fields.sessionId !== "string" || !SESSION_ID.test(fields.sessionId)) return null
  return {
    agent: agent as AgentKind,
    sessionId: fields.sessionId,
    resume: fields.resume === true,
    prompt: typeof fields.prompt === "string" && fields.prompt.trim() ? fields.prompt : undefined,
    model: flagValue(fields.model),
    effort: flagValue(fields.effort),
    permissions: permissionsFrom(fields.permissions),
  }
}

/** What `cogpitAgentEnv` adds to the server's environment, which a terminal already starts from. */
function cogpitAdditions(sessionId: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cogpitAgentEnv({ ...process.env }, sessionId))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && process.env[entry[0]] !== entry[1]),
  )
}

function physical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The terminal inherits the server's environment, so the CLI keeps the
 * session wherever that points; the chat can only follow it from the home
 * Cogpit reads. Throws when the two differ, before anything starts.
 */
function assertSharedHome(descriptor: AgentDescriptor): void {
  const configured = getConfig()?.claudeDir
  const envVar = descriptor.cli.sdkHomeEnvVar ?? descriptor.cli.homeEnvVar
  const cliHome = (envVar && process.env[envVar]) || join(homedir(), descriptor.cli.homeDirName)
  if (!configured || physical(expandHome(configured)) === physical(cliHome)) return
  throw new AgentRuntimeError(409, "HOME_MISMATCH", `${descriptor.displayName} keeps its sessions in ${cliHome}, but Cogpit reads ${configured}, so the chat could not follow a Code Mode session.`)
}

/**
 * The CLI in its Code Mode, for the terminal panel: the binary the agent's
 * sessions run, the composer's model, effort and access, the settings Cogpit
 * gives its own sessions, and the environment every agent it starts gets, so
 * `cogpit-session` and the browser work there too.
 */
export function agentCodeModeLaunch(request: CodeModeRequest): AgentTerminalLaunch {
  const descriptor = descriptorFor(request.agent)
  const { codeMode } = descriptor.cli
  if (!codeMode) throw new AgentRuntimeError(400, "NO_CODE_MODE", `${descriptor.displayName} has no Code Mode`)
  assertSharedHome(descriptor)
  const args = [
    ...(request.resume ? descriptor.resume.args(request.sessionId) : codeMode.newSession(request.sessionId)),
    ...descriptor.launchArgs.model(request.model),
    ...descriptor.launchArgs.effort(request.effort),
    // Without a choice the CLI applies the user's own default access.
    ...(request.permissions ? descriptor.launchArgs.permissions(request.permissions) : []),
    ...codeMode.settingsArgs,
    ...(request.prompt ? codeMode.prompt(request.prompt) : []),
  ]
  const env = { ...cogpitAdditions(request.sessionId), ...codeMode.env }
  return agentTerminalLaunch(spawnedExecutableFor(request.agent), descriptor.binName, args, env)
}
