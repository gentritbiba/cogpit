import { isAbsolute, resolve } from "node:path"
import { AGENT_KINDS, type AgentKind } from "../../shared/session/agent-descriptors"
import { AgentRuntimeError } from "../agents/runtimeTypes"
import {
  listPendingInput,
  respondToPendingInput,
  type PendingInput,
  type PendingInputResponse,
} from "../agents/pendingInput"
import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import { RouteError } from "../lib/routeError"
import { sessionChildren } from "../lib/sessionLineage"
import { readSessionResult } from "../lib/sessionResult"
import {
  clearTurnError,
  DEFAULT_WAIT_SECONDS,
  parseWaitSeconds,
  readSessionState,
  recordTurnError,
  waitForSessions,
  type SessionState,
} from "../lib/sessionWait"
import { createSession } from "../routes/session-new/sessionSpawner"
import { sendToSession } from "../routes/session-send"

/**
 * The `cogpit-session` CLI, run on the server. The script Cogpit installs in
 * `~/.cogpit/bin` only forwards argv here and prints what comes back, so the
 * commands can change with the server without the script going stale.
 */

export const CLI_NAME = "cogpit-session"

export interface CliInvocation {
  argv: string[]
  /** The caller's working directory, the default project for `new`. */
  cwd: string
  /** The calling agent's own session, from `COGPIT_SESSION_ID`. */
  callerSessionId?: string
  /** Stable across the script's retries of one invocation. */
  invocationId: string
  /** Who the create-once guarantee is scoped to. */
  scope: string
  signal?: AbortSignal
}

export interface CliOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export const EXIT = { ok: 0, error: 1, needsInput: 2, timedOut: 3 } as const

export const USAGE = `Usage: ${CLI_NAME} <command> [args]

Start and drive other agent sessions through Cogpit. Output is JSON unless noted.

  new MESSAGE [--cwd DIR] [--agent ${AGENT_KINDS.join("|")}] [--model M] [--effort E]
      [--mode MODE] [--worktree NAME] [--name TITLE] [--wait] [--timeout SECS]
        Start a session in DIR (default: your working directory). Runs with
        --mode bypassPermissions unless you pick another mode. Retries are safe.
  send ID MESSAGE [--interrupt] [--wait] [--timeout SECS]
        Send a follow-up. --interrupt stops the current turn first.
  wait ID... [--any] [--timeout SECS]
        Block until the session(s) finish or need input (default ${DEFAULT_WAIT_SECONDS}s).
        Prints the final reply and changed files when a session is done.
  status ID                 Current outcome and anything it is blocked on.
  result ID [--turn N] [--text]
        Final reply, changed files and tokens; --text prints only the reply.
  approve ID [--request REQ] [--always]
  deny ID [--request REQ] [--feedback TEXT]
        Answer a permission prompt (or a plan approval).
  answer ID ANSWER... [--request REQ] [--json '{"question":"answer"}']
        Answer a question the session asked; one ANSWER per question.
  interrupt ID              Stop the current turn, keep the session.
  stop ID... | --children   End sessions; --children stops every session you started.
  children [ID]             Sessions started by ID (default: you), with their state.

MESSAGE may be several words, or "-" to read it from stdin.

Outcomes: running | needs_input | completed | error | not_found
Exit codes: 0 done, 1 error, 2 needs input, 3 still running after --timeout.`

class UsageError extends Error {}

interface ParsedArgs {
  positionals: string[]
  values: Map<string, string>
  switches: Set<string>
}

function parseArgs(args: string[], valueFlags: readonly string[], switchFlags: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), switches: new Set() }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--") || arg === "--") {
      parsed.positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    if (switchFlags.includes(name) && eq === -1) {
      parsed.switches.add(name)
    } else if (valueFlags.includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
      if (value === undefined) throw new UsageError(`--${name} needs a value`)
      parsed.values.set(name, value)
    } else {
      throw new UsageError(`Unknown option --${name}`)
    }
  }
  return parsed
}

function json(value: unknown, exitCode: number = EXIT.ok): CliOutput {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" }
}

function sessionIdArg(args: ParsedArgs, command: string): string {
  const id = args.positionals.shift()
  if (!id) throw new UsageError(`${command} needs a session id`)
  return id
}

function messageArg(args: ParsedArgs, command: string): string {
  const message = args.positionals.join(" ").trim()
  if (!message) throw new UsageError(`${command} needs a message`)
  return message
}

function timeoutArg(args: ParsedArgs): number {
  const seconds = parseWaitSeconds(args.values.get("timeout"))
  if (seconds === null) throw new UsageError("--timeout must be a non-negative number of seconds")
  return seconds * 1000
}

// ── Reports ─────────────────────────────────────────────────────────────────

/** How to answer each pending request, spelled as the command to run. */
function answerHints(sessionId: string, waiting: PendingInput[]): string[] {
  return waiting.map((request) => {
    const target = `${CLI_NAME} %s ${sessionId} --request ${request.requestId}`
    switch (request.kind) {
      case "permission":
        return `${target.replace("%s", "approve")}  |  ${target.replace("%s", "deny")}`
      case "plan":
        return `${target.replace("%s", "approve")}  |  ${target.replace("%s", "deny")} --feedback "..."`
      case "question":
        return `${target.replace("%s", "answer")} "<one answer per question>"`
    }
  })
}

function exitCodeFor(states: SessionState[], timedOut: boolean): number {
  if (timedOut) return EXIT.timedOut
  if (states.some((state) => state.outcome === "needs_input")) return EXIT.needsInput
  if (states.some((state) => state.outcome === "error" || state.outcome === "not_found")) return EXIT.error
  return EXIT.ok
}

/** One session's state, plus its answer once it is done. */
async function describe(state: SessionState, timedOut = false): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    sessionId: state.sessionId,
    outcome: state.outcome,
    ...(state.status ? { status: state.status } : {}),
    ...(state.toolName ? { toolName: state.toolName } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
  if (state.outcome === "running") {
    if (state.pendingAgentDescriptions?.length) report.pendingAgents = state.pendingAgentDescriptions
    if (timedOut) report.next = `${CLI_NAME} wait ${state.sessionId}`
  }
  if (state.outcome === "needs_input") {
    report.waiting = state.waiting
    report.next = answerHints(state.sessionId, state.waiting)
  }
  if (state.outcome === "completed" || state.outcome === "error") {
    const result = await readSessionResult(state.sessionId)
    if (result) {
      report.reply = result.turn?.reply ?? null
      report.filesChanged = result.filesChanged
    }
  }
  return report
}

async function waitAndDescribe(
  sessionIds: string[],
  mode: "any" | "all",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CliOutput> {
  const { timedOut, sessions } = await waitForSessions(sessionIds, { mode, timeoutMs, signal })
  const reports = await Promise.all(sessions.map((state) => describe(state, timedOut)))
  const exitCode = exitCodeFor(mode === "any" && !timedOut
    ? sessions.filter((state) => state.outcome !== "running")
    : sessions, timedOut)
  return sessionIds.length === 1
    ? json(reports[0], exitCode)
    : json({ timedOut, sessions: reports }, exitCode)
}

// ── Commands ────────────────────────────────────────────────────────────────

async function newCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["cwd", "agent", "model", "effort", "mode", "worktree", "name", "timeout"], ["wait"])
  const message = messageArg(args, "new")
  const agent = args.values.get("agent")
  if (agent !== undefined && !AGENT_KINDS.includes(agent as AgentKind)) {
    throw new UsageError(`--agent must be one of ${AGENT_KINDS.join(", ")}`)
  }
  const cwdFlag = args.values.get("cwd")
  const cwd = cwdFlag === undefined ? inv.cwd : isAbsolute(cwdFlag) ? cwdFlag : resolve(inv.cwd, cwdFlag)
  const timeoutMs = timeoutArg(args)

  const started = await createSession({
    cwd,
    agent: agent as AgentKind | undefined,
    message,
    permissions: { mode: args.values.get("mode") ?? "bypassPermissions" },
    model: args.values.get("model"),
    effort: args.values.get("effort"),
    worktreeName: args.values.get("worktree"),
    name: args.values.get("name"),
    parentSessionId: inv.callerSessionId,
    retry: { requestId: inv.invocationId, scope: inv.scope },
  })
  if (args.switches.has("wait")) return waitAndDescribe([started.sessionId], "all", timeoutMs, inv.signal)
  return json({
    sessionId: started.sessionId,
    dirName: started.dirName,
    next: `${CLI_NAME} wait ${started.sessionId}`,
  })
}

async function sendCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["timeout"], ["interrupt", "wait"])
  const sessionId = sessionIdArg(args, "send")
  const message = messageArg(args, "send")
  const timeoutMs = timeoutArg(args)

  if (args.switches.has("interrupt")) {
    const { kind } = await resolveSessionAgent(sessionId)
    await runtimeFor(kind).interrupt(sessionId)
  }
  clearTurnError(sessionId)
  const { outcome } = await sendToSession(sessionId, { message })
  // A resume reports its failure only on the promise; keep it for `wait`.
  outcome.completion
    ?.then((result) => {
      if (result.isError) recordTurnError(sessionId, result.message || "The turn failed")
    })
    .catch((error: unknown) => recordTurnError(sessionId, error instanceof Error ? error.message : String(error)))

  if (args.switches.has("wait")) return waitAndDescribe([sessionId], "all", timeoutMs, inv.signal)
  return json({ sessionId, delivery: outcome.delivery, next: `${CLI_NAME} wait ${sessionId}` })
}

async function waitCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["timeout"], ["any"])
  if (args.positionals.length === 0) throw new UsageError("wait needs at least one session id")
  return waitAndDescribe(
    [...new Set(args.positionals)],
    args.switches.has("any") ? "any" : "all",
    timeoutArg(args),
    inv.signal,
  )
}

async function statusCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, [], [])
  const state = await readSessionState(sessionIdArg(args, "status"))
  const report: Record<string, unknown> = {
    sessionId: state.sessionId,
    outcome: state.outcome,
    live: state.live,
    running: state.running,
    ...(state.status ? { status: state.status } : {}),
    ...(state.toolName ? { toolName: state.toolName } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.pendingAgentDescriptions?.length ? { pendingAgents: state.pendingAgentDescriptions } : {}),
  }
  if (state.waiting.length > 0) {
    report.waiting = state.waiting
    report.next = answerHints(state.sessionId, state.waiting)
  }
  return json(report, exitCodeFor([state], false))
}

async function resultCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["turn"], ["text"])
  const sessionId = sessionIdArg(args, "result")
  const rawTurn = args.values.get("turn")
  const turn = rawTurn === undefined ? undefined : Number(rawTurn)
  if (turn !== undefined && (!Number.isInteger(turn) || turn < 0)) {
    throw new UsageError("--turn must be a non-negative integer")
  }
  const result = await readSessionResult(sessionId, turn)
  if (!result) return { exitCode: EXIT.error, stdout: "", stderr: `Session ${sessionId} not found\n` }
  if (args.switches.has("text")) return { exitCode: EXIT.ok, stdout: `${result.turn?.reply ?? ""}\n`, stderr: "" }
  return json(result)
}

/** The request an answer is for: named by --request, or the only one of its kind. */
function pickRequest(
  sessionId: string,
  requestId: string | undefined,
  kinds: readonly PendingInput["kind"][],
): string {
  if (requestId) return requestId
  const candidates = listPendingInput(sessionId).filter((request) => kinds.includes(request.kind))
  if (candidates.length === 1) return candidates[0].requestId
  if (candidates.length === 0) throw new UsageError(`Session ${sessionId} has nothing pending to answer that way`)
  throw new UsageError(
    `Session ${sessionId} has ${candidates.length} pending requests; pick one with --request: ${candidates.map((c) => c.requestId).join(", ")}`,
  )
}

async function respond(sessionId: string, requestId: string, response: PendingInputResponse): Promise<CliOutput> {
  const answered = await respondToPendingInput(sessionId, requestId, response)
  return json({ sessionId, answered: answered.requestId, kind: answered.kind })
}

async function approveCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["request"], ["always"])
  const sessionId = sessionIdArg(args, "approve")
  const requestId = pickRequest(sessionId, args.values.get("request"), ["permission", "plan"])
  const kind = listPendingInput(sessionId).find((request) => request.requestId === requestId)?.kind
  return respond(sessionId, requestId, kind === "plan"
    ? { approved: true }
    : { decision: args.switches.has("always") ? "allow_always" : "allow" })
}

async function denyCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["request", "feedback"], [])
  const sessionId = sessionIdArg(args, "deny")
  const requestId = pickRequest(sessionId, args.values.get("request"), ["permission", "plan"])
  const kind = listPendingInput(sessionId).find((request) => request.requestId === requestId)?.kind
  return respond(sessionId, requestId, kind === "plan"
    ? { approved: false, feedback: args.values.get("feedback") }
    : { decision: "deny" })
}

async function answerCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["request", "json"], [])
  const sessionId = sessionIdArg(args, "answer")
  const requestId = pickRequest(sessionId, args.values.get("request"), ["question"])
  const rawJson = args.values.get("json")
  if (rawJson !== undefined) {
    let answers: unknown
    try {
      answers = JSON.parse(rawJson)
    } catch {
      throw new UsageError("--json must be a JSON object of question → answer")
    }
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
      throw new UsageError("--json must be a JSON object of question → answer")
    }
    return respond(sessionId, requestId, { answers: answers as Record<string, string> })
  }
  if (args.positionals.length === 0) throw new UsageError("answer needs an ANSWER or --json")
  return respond(sessionId, requestId, {
    answers: args.positionals.length === 1 ? args.positionals[0] : args.positionals,
  })
}

async function interruptCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const sessionId = sessionIdArg(parseArgs(rest, [], []), "interrupt")
  const { kind } = await resolveSessionAgent(sessionId)
  const interrupted = await runtimeFor(kind).interrupt(sessionId)
  return json({ sessionId, interrupted }, interrupted ? EXIT.ok : EXIT.error)
}

async function stopCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, [], ["children"])
  const ids = [...args.positionals]
  if (args.switches.has("children")) {
    if (!inv.callerSessionId) throw new UsageError("--children needs COGPIT_SESSION_ID; run it from a Cogpit session")
    ids.push(...await sessionChildren(inv.callerSessionId))
  }
  if (ids.length === 0) throw new UsageError("stop needs a session id or --children")
  const stopped = await Promise.all([...new Set(ids)].map(async (sessionId) => {
    const { kind } = await resolveSessionAgent(sessionId)
    return { sessionId, stopped: await runtimeFor(kind).stop(sessionId) }
  }))
  return json({ sessions: stopped })
}

async function childrenCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, [], [])
  const parentId = args.positionals[0] ?? inv.callerSessionId
  if (!parentId) throw new UsageError("children needs a session id outside a Cogpit session")
  const children = await Promise.all((await sessionChildren(parentId)).map(readSessionState))
  return json({
    sessionId: parentId,
    children: children.map((state) => ({
      sessionId: state.sessionId,
      outcome: state.outcome,
      ...(state.status ? { status: state.status } : {}),
      ...(state.waiting.length > 0 ? { waiting: state.waiting.length } : {}),
    })),
  })
}

const COMMANDS: Record<string, (inv: CliInvocation, rest: string[]) => Promise<CliOutput>> = {
  new: newCommand,
  send: sendCommand,
  wait: waitCommand,
  status: statusCommand,
  result: resultCommand,
  approve: approveCommand,
  deny: denyCommand,
  answer: answerCommand,
  interrupt: interruptCommand,
  stop: stopCommand,
  children: childrenCommand,
}

export async function runSessionCli(inv: CliInvocation): Promise<CliOutput> {
  const [command, ...rest] = inv.argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { exitCode: command ? EXIT.ok : EXIT.error, stdout: `${USAGE}\n`, stderr: "" }
  }
  const run = COMMANDS[command]
  if (!run) return { exitCode: EXIT.error, stdout: "", stderr: `Unknown command "${command}"\n\n${USAGE}\n` }
  try {
    return await run(inv, rest)
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: EXIT.error, stdout: "", stderr: `${error.message}\nRun "${CLI_NAME} help" for usage.\n` }
    }
    if (error instanceof RouteError || error instanceof AgentRuntimeError) {
      return { exitCode: EXIT.error, stdout: "", stderr: `${error.message}\n` }
    }
    return { exitCode: EXIT.error, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` }
  }
}
