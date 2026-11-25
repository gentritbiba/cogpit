// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Why an agent could not do what it was asked, sorted into the few cases a
 * person can act on, with the words to tell them.
 *
 * Each CLI reports the same two setup problems in its own words — a synthetic
 * reply, a failed turn carrying an HTTP 401, a session that would not start —
 * so everything that has to tell them apart asks here, and each format module
 * maps its own records onto these cases.
 */
import { AGENT_KINDS, descriptorFor, type AgentKind } from "./agent-descriptors"
import type { AgentFailure } from "./types"

export type { AgentFailure, AgentFailureReason } from "./types"

const NOT_INSTALLED = [
  /isn't installed on this computer/i,
  /native cli binary for \S+ not found/i,
  /(?:native binary|executable) not found at/i,
  /not installed or not found in path/i,
  /was not found on path/i,
]

const NOT_SIGNED_IN = [
  /not logged in/i,
  /invalid api key/i,
  /missing bearer or basic authentication/i,
  /not created with authentication info/i,
  /no github oauth token/i,
  /no authentication information found/i,
  /isn't signed in/i,
]

const HTTP_STATUS = /\b(?:status|http)\s+([1-5]\d\d)\b|\b([45]\d\d) (?:unauthorized|forbidden|not found|too many requests|internal server error|bad gateway|service unavailable)\b/i

function statusIn(message: string): number | undefined {
  const match = HTTP_STATUS.exec(message)
  const code = match?.[1] ?? match?.[2]
  return code ? Number(code) : undefined
}

/** Sort a failure the agent reported as text, with its HTTP status when it gave one. */
export function classifyAgentFailure(message: string, httpStatus?: number): AgentFailure {
  const status = httpStatus ?? statusIn(message)
  const withStatus = status === undefined ? {} : { httpStatus: status }
  if (NOT_INSTALLED.some((pattern) => pattern.test(message))) return { reason: "not_installed", message }
  if (agentConfigInvalidIn(message)) return { reason: "config_invalid", message }
  if (status === 401 || NOT_SIGNED_IN.some((pattern) => pattern.test(message))) {
    return { reason: "not_signed_in", message, ...withStatus }
  }
  return { reason: status === undefined ? "other" : "http_status", message, ...withStatus }
}

// ── What to tell the user ───────────────────────────────────────────────────

/** The command that installs the CLI on a machine running `platform`, when a person installs it at all. */
export function agentInstallCommand(kind: AgentKind, platform: string): string | null {
  return descriptorFor(kind).cli.install?.command(platform) ?? null
}

export function agentNotInstalledTitle(kind: AgentKind): string {
  return `${descriptorFor(kind).displayName} isn't installed on this computer.`
}

export function agentSignedOutTitle(kind: AgentKind): string {
  return `${descriptorFor(kind).displayName} isn't signed in.`
}

export function agentModelUnavailableTitle(kind: AgentKind): string {
  return `${descriptorFor(kind).displayName} can't use that model. Pick another model.`
}

/**
 * The whole not-installed message for a machine running `platform`: what is
 * wrong on the first line, how to fix it on the second.
 */
export function agentNotInstalledMessage(kind: AgentKind, platform: string): string {
  const page = descriptorFor(kind).cli.install?.page
  const command = agentInstallCommand(kind, platform)
  const steps = [page && `Install it from ${page}`, command && `run: ${command}`].filter(Boolean)
  return steps.length > 0
    ? `${agentNotInstalledTitle(kind)}\n${steps.join(", or ")}`
    : agentNotInstalledTitle(kind)
}

/** The agent a message from `agentNotInstalledMessage` is about, or null for any other message. */
export function agentNotInstalledIn(message: string): AgentKind | null {
  return AGENT_KINDS.find((kind) => message.startsWith(agentNotInstalledTitle(kind))) ?? null
}

/** A config file an agent would not start with, and the backup the agent named for it. */
export interface InvalidAgentConfig {
  path: string
  backupPath: string | null
}

const CONFIG_FILE_PREFIX = "File: "
const CONFIG_BACKUP_PREFIX = "Backup: "

export function agentConfigInvalidTitle(kind: AgentKind): string {
  return `${descriptorFor(kind).displayName} can't start: a config file isn't valid JSON.`
}

/** What is wrong, the file and its backup on a line each, then the agent's own words. */
export function agentConfigInvalidMessage(kind: AgentKind, file: InvalidAgentConfig, detail: string): string {
  return [
    agentConfigInvalidTitle(kind),
    `${CONFIG_FILE_PREFIX}${file.path}`,
    ...(file.backupPath ? [`${CONFIG_BACKUP_PREFIX}${file.backupPath}`] : []),
    detail,
  ].join("\n")
}

/** The agent and file a message from `agentConfigInvalidMessage` names, or null for any other message. */
export function agentConfigInvalidIn(message: string): (InvalidAgentConfig & { kind: AgentKind }) | null {
  const [title, fileLine, backupLine] = message.split("\n")
  const kind = AGENT_KINDS.find((candidate) => title === agentConfigInvalidTitle(candidate))
  if (!kind || !fileLine?.startsWith(CONFIG_FILE_PREFIX)) return null
  return {
    kind,
    path: fileLine.slice(CONFIG_FILE_PREFIX.length),
    backupPath: backupLine?.startsWith(CONFIG_BACKUP_PREFIX) ? backupLine.slice(CONFIG_BACKUP_PREFIX.length) : null,
  }
}

const TERMINAL_PREFIX = "Continue it in a terminal: "

/** A failure whose fix is to carry on in the agent's own terminal: what happened, the command, then the agent's own words. */
export function agentTerminalOnlyMessage(title: string, command: string, detail: string): string {
  return [title, `${TERMINAL_PREFIX}${command}`, detail].join("\n")
}

/** The command a message from `agentTerminalOnlyMessage` hands to a terminal, or null for any other message. */
export function agentTerminalCommandIn(message: string): string | null {
  const line = message.split("\n")[1]
  return line?.startsWith(TERMINAL_PREFIX) ? line.slice(TERMINAL_PREFIX.length) : null
}

function codeModeOnlyTitle(kind: AgentKind): string {
  return `This session was started in Code Mode, so it can only be continued in ${descriptorFor(kind).displayName} in a terminal.`
}

/** A refusal to continue a session the agent started in Code Mode, which runs only in its own terminal. */
export function agentCodeModeOnlyMessage(kind: AgentKind, command: string, detail: string): string {
  return agentTerminalOnlyMessage(codeModeOnlyTitle(kind), command, detail)
}

/** Whether a message is the refusal from `agentCodeModeOnlyMessage`. */
export function isAgentCodeModeOnly(message: string): boolean {
  const title = message.split("\n")[0]
  return AGENT_KINDS.some((kind) => title === codeModeOnlyTitle(kind))
}

/** One line for a status label, in the same plain words the card uses. */
export function agentFailureTitle(kind: AgentKind, failure: AgentFailure): string {
  switch (failure.reason) {
    case "not_installed": return agentNotInstalledTitle(kind)
    case "not_signed_in": return agentSignedOutTitle(kind)
    case "config_invalid": return agentConfigInvalidTitle(kind)
    case "model_unavailable": return agentModelUnavailableTitle(kind)
    default: return `${descriptorFor(kind).displayName} stopped with an error.`
  }
}
