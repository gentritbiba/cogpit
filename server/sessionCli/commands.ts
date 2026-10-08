import { accessLevelOf, editionModule } from "../edition"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { acknowledgeTask, cancelTask, refreshDelegatedTasks } from "../orchestration/delegatedTasks"
import { delegationAuthority } from "../lib/delegationAuthority"
import { orchestrationStore } from "../orchestration/storage"
import { resumeDelegations } from "../lib/delegationAuthority"
import { hostname } from "node:os"
import type { IncomingMessage } from "node:http"
import { isAbsolute, resolve } from "node:path"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import type { PendingInput, PendingInputResponse } from "../agents/pendingInput"
import type { VisibilityCheck } from "../edition"
import { deviceJson } from "../hub/deviceRequest"
import { clearSessionHandoff, recordSessionOrigin, sessionChildren, sessionOrigin } from "../lib/sessionOrigins"
import { DEFAULT_WAIT_SECONDS, isSettled, parseWaitSeconds, type SessionState } from "../lib/sessionWait"
import {
  hostForSession,
  ensureSessionApi,
  hostNamed,
  localHost,
  locateSessions,
  remoteHostsList,
  waitAcrossHosts,
  type SessionHost,
} from "../sessionHosts"
import { markDelegatedRequestAnswered, watchDelegatedRequestsOf } from "../sessionHosts/delegatedRequests"
import { resolveDeviceName } from "../lib/standalone-bootstrap"
import { load as loadYaml } from "js-yaml"
import { parseBoardContent, parseBoardProgress } from "../../shared/contracts/board"
import { clearSessionBoard, sessionBoard, setSessionBoard, setSessionBoardProgress } from "../lib/sessionBoards"
import {
  discardWorkspace,
  fetchWorkspaceBack,
  handoffBriefing,
  sendWorkspace,
  type Handoff,
  type SentWorkspace,
} from "../workspaceTransfer/handoff"

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
  /**
   * Whether the caller may move repositories between machines. Workspace
   * transfers run with the hub's own device credentials, so a team member who
   * could not call the workspace routes must not reach them through here.
   */
  admin: boolean
  /** Which sessions the caller may see, and so which projects it may list. */
  visible: VisibilityCheck
  signal?: AbortSignal
  req?: IncomingMessage
}

export interface CliOutput {
  exitCode: number
  stdout: string
  stderr: string
}

export const EXIT = { ok: 0, error: 1, needsInput: 2, timedOut: 3 } as const

export const USAGE = `Usage: ${CLI_NAME} <command> [args]

Start and drive other agent sessions through Cogpit. Output is JSON unless noted.

  new MESSAGE [--device NAME] [--cwd DIR] [--agent ${AGENT_KINDS.join("|")}] [--instance ID] [--model M]
      [--effort E] [--mode MODE] [--worktree NAME] [--name TITLE] [--questions user|agent]
      [--wait] [--timeout SECS]
        Start a session in DIR (default: your working directory). Runs with
        --mode bypassPermissions for default CLI accounts; configured instances
        default to supervised mode. Creation retries reuse the invocation id.
        --device runs it on another machine: your repository (HEAD plus
        uncommitted changes) is sent there as a fresh worktree, and when the
        session finishes its work comes back as a local branch. Pass --cwd with
        a path on that machine to use a folder already there instead.
        --questions says who answers what it asks: you (agent, the default) or
        the user in Cogpit (user, the default with --device); wait keeps
        waiting while the user has it.
  send ID MESSAGE [--command-id ID] [--steer|--interrupt] [--wait] [--timeout SECS]
        Queue a follow-up and return a durable receipt. Reuse --command-id on
        retries. --steer joins a supported running turn; --interrupt restarts it.
  receipt COMMAND_ID --session ID [--wait] [--timeout SECS]
        Inspect one delivery. Unknown means inspect native history before retrying.
  tasks [PARENT_ID] [--ack TASK_ID|--cancel TASK_ID]
        Read durable delegated results. Timeout leaves the child running and
        reports its eventual result; successful blocking waits acknowledge it.
  transition ID --agent AGENT --revision N --mode resume|handoff
      [--instance ID] [--target ID] [--message TEXT] [--command-id ID]
        Continue the stable conversation on another compatible session or provider.
  transition ID --resolve --command-id ID [--target ID|--confirm-not-created]
        Recover an uncertain handoff after checking the native provider history.
  wait ID... [--any] [--timeout SECS]
        Block until the session(s) finish or need input (default ${DEFAULT_WAIT_SECONDS}s).
        Prints the final reply and changed files when a session is done.
  status ID                 Current outcome and anything it is blocked on.
  result ID [--turn N] [--text]
        Final reply, changed files and tokens; --text prints only the reply.
  fetch ID                  Bring a handed-over session's work back as a local
                            branch now (wait does it when the session finishes).
  discard ID                Stop a handed-over session, bring its work back one
                            last time and delete its worktree on the device.
  approve ID [--request REQ] [--always]
  deny ID [--request REQ] [--feedback TEXT]
        Answer a permission prompt (or a plan approval).
  answer ID ANSWER... [--request REQ] [--json '{"question":"answer"}']
        Answer a question the session asked; one ANSWER per question.
  interrupt ID              Stop the current turn, keep the session.
  stop ID... | --children   End sessions; --children stops every session you started.
  children [ID]             Sessions started by ID (default: you), with their state.
  board set YAML|-          Replace your board, the summary pinned above your crew's
                            composer: title, progress (DONE/TOTAL) and sections of
                            { title, tone: warning|success, items }. YAML or JSON.
  board progress DONE/TOTAL Move only your board's progress, such as 35/99.
  board get [ID]            Print a session's board (default: yours).
  board clear               Remove your board.
  devices                   Machines this Cogpit can run sessions on.
  projects [--device NAME]  Project folders on this machine or a device.

Session ids work on any machine; the CLI finds where each one runs.

MESSAGE may be several words, or "-" to read it from stdin.

Outcomes: running | needs_input | completed | error | not_found | unreachable
Exit codes: 0 done, 1 error, 2 needs input, 3 still running after --timeout.`

class UsageError extends Error {}

function requireAdmin(inv: CliInvocation, action: string): void {
  if (!inv.admin) throw new Error(`Only an admin can ${action}`)
}

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
  if (states.some((state) => ["error", "not_found", "unreachable"].includes(state.outcome))) return EXIT.error
  return EXIT.ok
}

const deviceField = (host: SessionHost) => (host.remote ? { device: host.name } : {})

/** The work a handed-over session did, brought back, with how to use it. */
async function returnedWork(deviceId: string, handoff: Handoff): Promise<Record<string, unknown>> {
  try {
    const work = await fetchWorkspaceBack(deviceId, handoff)
    const target = work.branchUpdated ? work.branch : work.ref
    const range = `${work.base.slice(0, 12)} ${target}`
    return {
      returned: work.branchUpdated ? work : {
        ...work,
        note: `${work.branch} is checked out or has commits of its own, so it was left alone; the returned work is at ${work.ref}`,
      },
      apply: work.files.length > 0
        ? [
            `Review: git -C ${handoff.repoRoot} diff ${range}`,
            `Apply to the working tree: git -C ${handoff.repoRoot} diff ${range} | git -C ${handoff.repoRoot} apply`,
          ]
        : undefined,
    }
  } catch (error) {
    return { returnError: `Could not bring the work back: ${error instanceof Error ? error.message : String(error)}` }
  }
}

interface DescribeOptions {
  timedOut?: boolean
  askedUser?: boolean
  handoff?: { deviceId: string; handoff: Handoff }
}

/** One session's state, plus its answer (and returned work) once it is done. */
async function describe(
  host: SessionHost,
  state: SessionState,
  { timedOut = false, askedUser = false, handoff }: DescribeOptions = {},
): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    sessionId: state.sessionId,
    ...deviceField(host),
    outcome: state.outcome,
    ...(state.status ? { status: state.status } : {}),
    ...(state.toolName ? { toolName: state.toolName } : {}),
    ...(state.error ? { error: state.error } : {}),
  }
  if (state.outcome === "running" || state.outcome === "unreachable") {
    if (state.pendingAgentDescriptions?.length) report.pendingAgents = state.pendingAgentDescriptions
    if (timedOut) report.next = `${CLI_NAME} wait ${state.sessionId}`
  }
  if (state.outcome === "needs_input") {
    report.waiting = state.waiting
    report.next = askedUser
      ? [`The user was asked in Cogpit; ${CLI_NAME} wait ${state.sessionId} keeps waiting`, ...answerHints(state.sessionId, state.waiting)]
      : answerHints(state.sessionId, state.waiting)
    if (askedUser) report.askedUser = true
  }
  if (state.outcome === "completed" || state.outcome === "error") {
    const result = await host.result(state.sessionId)
    if (result) {
      report.reply = result.turn?.reply ?? null
      report.filesChanged = result.filesChanged
    }
    if (handoff) Object.assign(report, await returnedWork(handoff.deviceId, handoff.handoff))
  }
  return report
}

async function originsOf(sessionIds: readonly string[]) {
  const origins = await Promise.all(sessionIds.map(sessionOrigin))
  return new Map(sessionIds.map((sessionId, i) => [sessionId, origins[i]]))
}

/** How often a wait re-checks sessions that are only waiting on the user. */
const USER_WAIT_POLL_MS = 2000

async function waitAndDescribe(
  inv: CliInvocation,
  sessionIds: string[],
  mode: "any" | "all",
  timeoutMs: number,
): Promise<CliOutput> {
  const { signal } = inv
  const located = await locateSessions(sessionIds)
  const origins = await originsOf(sessionIds)
  const onUser = (state: SessionState) => state.outcome === "needs_input" && !!origins.get(state.sessionId)?.asksUser
  const done = (state: SessionState) => isSettled(state) && !onUser(state)

  const deadline = Date.now() + timeoutMs
  let { timedOut, sessions } = await waitAcrossHosts(located, { mode, timeoutMs, signal })
  while (!timedOut && !(mode === "all" ? sessions.every(done) : sessions.some(done))) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0 || signal?.aborted) {
      timedOut = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(USER_WAIT_POLL_MS, remainingMs)))
    ;({ timedOut, sessions } = await waitAcrossHosts(located, { mode, timeoutMs: Math.max(0, deadline - Date.now()), signal }))
  }

  const reports = await Promise.all(sessions.map((state, i) => {
    const origin = origins.get(state.sessionId)
    return describe(located[i].host, state, {
      timedOut,
      askedUser: onUser(state),
      handoff: inv.admin && origin?.handoff && origin.deviceId ? { deviceId: origin.deviceId, handoff: origin.handoff } : undefined,
    })
  }))
  const exitCode = exitCodeFor(mode === "any" && !timedOut ? sessions.filter(done) : sessions, timedOut)
  return sessionIds.length === 1
    ? json(reports[0], exitCode)
    : json({ timedOut, sessions: reports }, exitCode)
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * Workspaces already sent for an invocation, so the script retrying a `new`
 * whose answer it lost reuses the worktree instead of sending another.
 */
const sentWorkspaces = new Map<string, { sent: Promise<SentWorkspace>; at: number }>()
const SENT_WORKSPACE_TTL_MS = 60 * 60 * 1000

/** Joins a retry to the send already under way; a failed send may be tried again. */
function sendOnce(inv: CliInvocation, host: SessionHost, task: string): Promise<SentWorkspace> {
  const key = `${inv.scope}:${inv.invocationId}`
  const now = Date.now()
  for (const [cached, { at }] of sentWorkspaces) if (now - at > SENT_WORKSPACE_TTL_MS) sentWorkspaces.delete(cached)
  const cached = sentWorkspaces.get(key)
  if (cached) return cached.sent
  // The device keys its import by the same id, so even a hub restart between retries imports once.
  const sent = sendWorkspace(host.id, host.name, inv.cwd, task, `${inv.scope}:${inv.invocationId}`)
  sentWorkspaces.set(key, { sent, at: now })
  sent.catch(() => sentWorkspaces.delete(key))
  return sent
}

function localCwd(inv: CliInvocation, cwdFlag: string | undefined): string {
  return cwdFlag === undefined ? inv.cwd : isAbsolute(cwdFlag) ? cwdFlag : resolve(inv.cwd, cwdFlag)
}

async function newCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(
    rest,
    ["device", "cwd", "agent", "instance", "model", "effort", "mode", "worktree", "name", "questions", "timeout"],
    ["wait"],
  )
  const message = messageArg(args, "new")
  const agent = args.values.get("agent")
  if (agent !== undefined && !AGENT_KINDS.includes(agent as AgentKind)) {
    throw new UsageError(`--agent must be one of ${AGENT_KINDS.join(", ")}`)
  }
  const deviceName = args.values.get("device")
  const host = deviceName === undefined ? localHost : hostNamed(deviceName)
  const cwdFlag = args.values.get("cwd")
  if (host.remote && cwdFlag !== undefined && !isAbsolute(cwdFlag)) {
    throw new UsageError(`--cwd must be an absolute path on ${host.name}; ${CLI_NAME} projects --device ${host.name} lists them`)
  }
  const timeoutMs = timeoutArg(args)
  const questionsFor = args.values.get("questions") ?? (host.remote ? "user" : "agent")
  if (questionsFor !== "user" && questionsFor !== "agent") throw new UsageError("--questions must be user or agent")

  const handingOver = host.remote && cwdFlag === undefined
  if (handingOver && args.values.has("worktree")) {
    throw new UsageError("--worktree cannot be combined with sending your repository; it already runs in its own worktree")
  }
  if (handingOver) {
    requireAdmin(inv, "send a repository to another machine")
    await ensureSessionApi(host.id)
  }
  const sent = handingOver ? await sendOnce(inv, host, args.values.get("name") ?? message) : undefined
  const started = await host.create({
    cwd: sent?.remoteCwd ?? (host.remote ? cwdFlag! : localCwd(inv, cwdFlag)),
    agent: agent as AgentKind | undefined,
    ...(args.values.has("instance") ? { instanceId: args.values.get("instance") } : {}),
    ...(inv.req ? { req: inv.req } : {}),
    message: sent ? `${handoffBriefing(sent, resolveDeviceName(process.env, hostname()))}\n\n${message}` : message,
    mode: args.values.get("mode") ?? (args.values.has("instance") || (agent && descriptorFor(agent as AgentKind).cli.requiresConfiguration) ? "default" : "bypassPermissions"),
    model: args.values.get("model"),
    effort: args.values.get("effort"),
    worktreeName: args.values.get("worktree"),
    name: args.values.get("name"),
    requestId: inv.invocationId,
    scope: inv.scope,
  })
  const name = args.values.get("name")
  await recordSessionOrigin(started.sessionId, {
    parentSessionId: inv.callerSessionId,
    ...(name ? { name } : {}),
    ...(host.remote ? { deviceId: host.id } : {}),
    ...(questionsFor === "user" ? { asksUser: true as const } : {}),
    ...(sent ? { handoff: sent.handoff } : {}),
  })
  const blocking = args.switches.has("wait")
  const task = inv.callerSessionId ? orchestrationStore().putTask(inv.scope, {
    parentSessionId: inv.callerSessionId, childSessionId: started.sessionId, sourceId: inv.invocationId,
    deliveryDisposition: blocking ? "blocking" : "async", blockingDeadline: blocking ? Date.now() + timeoutMs + 10000 : undefined,
  }) : undefined
  if (inv.callerSessionId) {
    if (inv.req) resumeDelegations(inv.req, inv.callerSessionId)
  }
  if (blocking) {
    try {
      const output = await waitAndDescribe(inv, [started.sessionId], "all", timeoutMs)
      if (task) {
        const report = JSON.parse(output.stdout) as { outcome?: string; timedOut?: boolean }
        if (!report.timedOut && (report.outcome === "completed" || report.outcome === "error")) {
          const current = orchestrationStore().tasks(inv.scope).find((value) => value.id === task.id)
          if (current && current.state !== "cancelled") orchestrationStore().updateTask(inv.scope, task.id, { state: report.outcome, result: report, acknowledgedAt: Date.now() }, current.state)
        }
      }
      return output
    } finally {
      if (task) orchestrationStore().updateTask(inv.scope, task.id, { deliveryDisposition: "async", blockingDeadline: undefined })
      void refreshDelegatedTasks()
    }
  }
  return json({
    sessionId: started.sessionId,
    ...deviceField(host),
    dirName: started.dirName,
    ...(sent ? { workspace: { cwd: sent.remoteCwd, branch: sent.remoteBranch, returnsTo: sent.handoff.branch } } : {}),
    next: `${CLI_NAME} wait ${started.sessionId}`,
  })
}

async function sendCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["timeout", "command-id"], ["interrupt", "wait", "steer"])
  const sessionId = sessionIdArg(args, "send")
  await requireSessionAccess(inv, sessionId, true)
  const message = messageArg(args, "send")
  const timeoutMs = timeoutArg(args)

  const host = await hostForSession(sessionId)
  const commandId = args.values.get("command-id") ?? inv.invocationId
  const { delivery, receipt } = await host.send(sessionId, message, { interrupt: args.switches.has("interrupt"), intent: args.switches.has("steer") ? "steer" : args.switches.has("interrupt") ? "restart" : "queue", commandId, req: inv.req })
  watchDelegatedRequestsOf(sessionId)
  if (args.switches.has("wait")) {
    if (!host.receipt) throw new UsageError("This host cannot wait for durable command receipts; update it first")
    const settled = await host.receipt(commandId, inv.req, timeoutMs)
    return json({ sessionId, ...deviceField(host), receipt: settled }, settled?.state === "completed" ? EXIT.ok : settled && ["failed", "unknown", "held", "cancelled"].includes(settled.state) ? EXIT.error : EXIT.timedOut)
  }
  return json({ sessionId, ...deviceField(host), delivery, receipt, next: `${CLI_NAME} receipt ${commandId} --session ${sessionId}` })
}

async function waitCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["timeout"], ["any"])
  if (args.positionals.length === 0) throw new UsageError("wait needs at least one session id")
  for (const id of args.positionals) await requireSessionAccess(inv, id)
  return waitAndDescribe(
    inv,
    [...new Set(args.positionals)],
    args.switches.has("any") ? "any" : "all",
    timeoutArg(args),
  )
}

async function statusCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, [], [])
  const sessionId = sessionIdArg(args, "status")
  await requireSessionAccess(inv, sessionId)
  const host = await hostForSession(sessionId)
  const state = await host.state(sessionId)
  const report: Record<string, unknown> = {
    sessionId: state.sessionId,
    ...deviceField(host),
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

async function resultCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["turn"], ["text"])
  const sessionId = sessionIdArg(args, "result")
  await requireSessionAccess(inv, sessionId)
  const rawTurn = args.values.get("turn")
  const turn = rawTurn === undefined ? undefined : Number(rawTurn)
  if (turn !== undefined && (!Number.isInteger(turn) || turn < 0)) {
    throw new UsageError("--turn must be a non-negative integer")
  }
  const host = await hostForSession(sessionId)
  const result = await host.result(sessionId, turn)
  if (!result) return { exitCode: EXIT.error, stdout: "", stderr: `Session ${sessionId} not found\n` }
  if (args.switches.has("text")) return { exitCode: EXIT.ok, stdout: `${result.turn?.reply ?? ""}\n`, stderr: "" }
  return json({ ...deviceField(host), ...result })
}

/** The request an answer is for: named by --request, or the only one of its kind. */
async function pickRequest(
  host: SessionHost,
  sessionId: string,
  requestId: string | undefined,
  kinds: readonly PendingInput["kind"][],
): Promise<PendingInput | { requestId: string; kind?: undefined }> {
  const pending = (await host.state(sessionId)).waiting
  if (requestId) return pending.find((request) => request.requestId === requestId) ?? { requestId }
  const candidates = pending.filter((request) => kinds.includes(request.kind))
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) throw new UsageError(`Session ${sessionId} has nothing pending to answer that way`)
  throw new UsageError(
    `Session ${sessionId} has ${candidates.length} pending requests; pick one with --request: ${candidates.map((c) => c.requestId).join(", ")}`,
  )
}

async function respond(
  host: SessionHost,
  sessionId: string,
  requestId: string,
  response: PendingInputResponse,
  invocation?: CliInvocation,
  commandId?: string,
): Promise<CliOutput> {
  const answered = await host.respond(sessionId, requestId, response, { commandId: commandId ?? invocation?.invocationId, req: invocation?.req })
  markDelegatedRequestAnswered(sessionId, requestId)
  return json({ sessionId, ...deviceField(host), answered: answered.requestId, kind: answered.kind })
}

async function approvalCommand(inv: CliInvocation, rest: string[], verb: "approve" | "deny"): Promise<CliOutput> {
  const approved = verb === "approve"
  const args = parseArgs(rest, approved ? ["request"] : ["request", "feedback"], approved ? ["always"] : [])
  const sessionId = sessionIdArg(args, verb)
  await requireSessionAccess(inv, sessionId, true)
  const host = await hostForSession(sessionId)
  const request = await pickRequest(host, sessionId, args.values.get("request"), ["permission", "plan"])
  const response: PendingInputResponse = request.kind === "plan"
    ? { approved, ...(!approved && { feedback: args.values.get("feedback") }) }
    : { decision: approved ? args.switches.has("always") ? "allow_always" : "allow" : "deny" }
  return respond(host, sessionId, request.requestId, response, inv)
}

async function answerCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["request", "json", "command-id"], [])
  const sessionId = sessionIdArg(args, "answer")
  await requireSessionAccess(inv, sessionId, true)
  const host = await hostForSession(sessionId)
  const commandId = args.values.get("command-id") ?? inv.invocationId
  const cached = args.values.has("request") || !host.receipt ? null : await host.receipt(commandId, inv.req)
  if (cached && cached.sessionId !== sessionId) throw new UsageError("This answer receipt belongs to another session")
  const { requestId } = await pickRequest(host, sessionId, args.values.get("request") ?? cached?.questionId, ["question"])
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
    return respond(host, sessionId, requestId, { answers: answers as Record<string, string> }, inv, args.values.get("command-id"))
  }
  if (args.positionals.length === 0) throw new UsageError("answer needs an ANSWER or --json")
  return respond(host, sessionId, requestId, {
    answers: args.positionals.length === 1 ? args.positionals[0] : args.positionals,
  }, inv, args.values.get("command-id"))
}

async function receiptCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["session", "timeout"], ["wait"])
  const commandId = args.positionals[0]
  const sessionId = args.values.get("session")
  if (!commandId || !sessionId) throw new UsageError("receipt needs COMMAND_ID --session SESSION_ID")
  await requireSessionAccess(inv, sessionId)
  const host = await hostForSession(sessionId)
  if (!host.receipt) throw new UsageError("Update this host to read durable receipts")
  const receipt = await host.receipt(commandId, inv.req, args.switches.has("wait") ? timeoutArg(args) : undefined)
  if (!receipt) throw new UsageError("Command receipt not found")
  if (receipt.sessionId !== sessionId) throw new UsageError("This receipt belongs to a different session")
  return json({ receipt, ...deviceField(host) })
}

async function interruptCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const sessionId = sessionIdArg(parseArgs(rest, [], []), "interrupt")
  await requireSessionAccess(inv, sessionId, true)
  const host = await hostForSession(sessionId)
  const interrupted = await host.interrupt(sessionId)
  return json({ sessionId, ...deviceField(host), interrupted }, interrupted ? EXIT.ok : EXIT.error)
}

async function stopCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, [], ["children"])
  const ids = [...args.positionals]
  if (args.switches.has("children")) {
    if (!inv.callerSessionId) throw new UsageError("--children needs COGPIT_SESSION_ID; run it from a Cogpit session")
    await requireSessionAccess(inv, inv.callerSessionId, true)
    ids.push(...await sessionChildren(inv.callerSessionId))
  }
  if (ids.length === 0) throw new UsageError("stop needs a session id or --children")
  for (const id of ids) await requireSessionAccess(inv, id, true)
  const located = await locateSessions([...new Set(ids)])
  const stopped = await Promise.all(located.map(async ({ host, sessionId }) => ({
    sessionId,
    ...deviceField(host),
    stopped: await host.stop(sessionId).catch(() => false),
  })))
  return json({ sessions: stopped })
}

async function childrenCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, [], [])
  const parentId = args.positionals[0] ?? inv.callerSessionId
  if (!parentId) throw new UsageError("children needs a session id outside a Cogpit session")
  await requireSessionAccess(inv, parentId)
  const visibleChildren = []
  for (const id of await sessionChildren(parentId)) { try { await requireSessionAccess(inv, id); visibleChildren.push(id) } catch { /* Omit sessions outside this caller’s view. */ } }
  const located = await locateSessions(visibleChildren)
  const children = await Promise.all(located.map(async ({ host, sessionId }) => {
    const state = await host.state(sessionId)
    return {
      sessionId,
      ...deviceField(host),
      outcome: state.outcome,
      ...(state.status ? { status: state.status } : {}),
      ...(state.waiting.length > 0 ? { waiting: state.waiting.length } : {}),
    }
  }))
  return json({ sessionId: parentId, children })
}

async function fetchCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  requireAdmin(inv, "bring a repository back from another machine")
  const sessionId = sessionIdArg(parseArgs(rest, [], []), "fetch")
  await requireSessionAccess(inv, sessionId, true)
  const origin = await sessionOrigin(sessionId)
  if (!origin?.handoff || !origin.deviceId) {
    throw new UsageError(`Session ${sessionId} was not handed to another machine with its repository`)
  }
  const report = await returnedWork(origin.deviceId, origin.handoff)
  return json({ sessionId, ...report }, report.returnError ? EXIT.error : EXIT.ok)
}

async function discardCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  requireAdmin(inv, "delete a workspace on another machine")
  const sessionId = sessionIdArg(parseArgs(rest, [], []), "discard")
  await requireSessionAccess(inv, sessionId, true)
  const origin = await sessionOrigin(sessionId)
  if (!origin?.handoff || !origin.deviceId) {
    throw new UsageError(`Session ${sessionId} was not handed to another machine with its repository`)
  }
  const host = await hostForSession(sessionId)
  // A session that is still running could write after the last fetch, and the
  // worktree is deleted right after it.
  await host.stop(sessionId)
  const state = await host.state(sessionId)
  if (state.running || state.outcome === "running") {
    throw new Error(`Session ${sessionId} is still running; stop it before discarding`)
  }
  if (state.outcome === "unreachable") {
    throw new Error(`Could not confirm session ${sessionId} has stopped${state.error ? `: ${state.error}` : ""}`)
  }
  // Bring the work back one last time, so discarding never loses it.
  const report = await returnedWork(origin.deviceId, origin.handoff)
  if (report.returnError) return json({ sessionId, ...report }, EXIT.error)
  await discardWorkspace(origin.deviceId, origin.handoff)
  await clearSessionHandoff(sessionId)
  return json({ sessionId, ...report, discarded: true })
}

/** How long `devices` waits on each device before calling it offline. */
const DEVICE_PROBE_TIMEOUT_MS = 4000

async function devicesCommand(_inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  parseArgs(rest, [], [])
  const devices = await Promise.all(remoteHostsList().map(async (host) => {
    try {
      const hello = await deviceJson<{ version?: string; sessionApi?: number }>(
        host.id, "GET", "/api/hello", undefined, { timeoutMs: DEVICE_PROBE_TIMEOUT_MS },
      )
      return {
        name: host.name,
        id: host.id,
        online: true,
        version: hello.version ?? null,
        ...(hello.sessionApi ? {} : { note: "Too old to run sessions for this machine; update it" }),
      }
    } catch (error) {
      return { name: host.name, id: host.id, online: false, error: error instanceof Error ? error.message : String(error) }
    }
  }))
  return json({ devices })
}

async function projectsCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["device"], [])
  const deviceName = args.values.get("device")
  const host = deviceName === undefined ? localHost : hostNamed(deviceName)
  const projects = await host.projects(inv.visible)
  return json({
    ...deviceField(host),
    projects: projects.map((project) => ({
      path: project.path,
      name: project.shortName,
      ...(project.lastModified ? { lastModified: project.lastModified } : {}),
    })),
  })
}

async function requireSessionAccess(inv: CliInvocation, id: string, mutate = false): Promise<void> {
  if (inv.req) { const level = await accessLevelOf(inv.req, id); if (!level || !accessAtLeast(level, mutate ? "interact" : "view")) throw new UsageError("Session access denied") }
  else if (editionModule().auth) throw new UsageError("An authenticated request is required")
}
async function tasksCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["ack", "cancel"], [])
  const parent = args.positionals[0] || inv.callerSessionId
  if (!parent) throw new UsageError("tasks needs a parent session ID")
  await requireSessionAccess(inv, parent, Boolean(args.values.has("ack") || args.values.has("cancel")))
  if (inv.req) resumeDelegations(inv.req, parent)
  if (args.values.has("ack")) {
    const task = orchestrationStore().tasks(inv.scope, parent).find((value) => value.id === args.values.get("ack"))
    if (!task) throw new UsageError("Delegated task not found")
    await requireSessionAccess(inv, task.childSessionId, true)
    acknowledgeTask(inv.scope, parent, task.id)
  }
  if (args.values.has("cancel")) { if (!inv.req) throw new UsageError("Cancellation requires an authenticated request"); await cancelTask(inv.scope, parent, args.values.get("cancel")!, delegationAuthority(inv.req)) }
  await refreshDelegatedTasks()
  const tasks = []
  for (const task of orchestrationStore().tasks(inv.scope, parent)) { try { await requireSessionAccess(inv, task.childSessionId); tasks.push(task) } catch { /* Omit inaccessible child results. */ } }
  return json({ tasks })
}
async function transitionCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const args = parseArgs(rest, ["agent", "instance", "revision", "mode", "target", "message", "command-id"], ["resolve", "confirm-not-created"])
  const sessionId = args.positionals[0]
  if (!sessionId || !inv.req) throw new UsageError("transition needs a session ID and an authenticated request")
  await requireSessionAccess(inv, sessionId, true)
  const host = await hostForSession(sessionId)
  if (!host.transition) throw new UsageError("Update this host to continue conversations across providers")
  const commandId = args.values.get("command-id") || inv.invocationId
  const result = await host.transition(args.switches.has("resolve") ? { action: "resolve", sessionId, commandId, targetSessionId: args.values.get("target"), confirmNotCreated: args.switches.has("confirm-not-created") } : { sessionId, commandId, expectedRevision: Number(args.values.get("revision")), mode: args.values.get("mode") as "resume" | "handoff", agent: args.values.get("agent") as AgentKind, instanceId: args.values.get("instance"), targetSessionId: args.values.get("target"), message: args.values.get("message") }, inv.req)
  return json(result)
}

/** The calling session, which the board verbs that change a board act on. */
async function boardOwner(inv: CliInvocation, verb: string): Promise<string> {
  if (!inv.callerSessionId) throw new UsageError(`board ${verb} needs COGPIT_SESSION_ID; run it from a Cogpit session`)
  await requireSessionAccess(inv, inv.callerSessionId, true)
  return inv.callerSessionId
}

async function boardCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const [verb, ...more] = rest
  const args = parseArgs(more, [], [])
  switch (verb) {
    case "set": {
      const owner = await boardOwner(inv, "set")
      const source = args.positionals.join(" ").trim()
      if (!source) throw new UsageError("board set needs YAML or JSON, or - to read it from stdin")
      let document: unknown
      try {
        document = loadYaml(source)
      } catch (error) {
        throw new UsageError(`board set could not read that: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
      }
      const content = parseBoardContent(document)
      if (!content) throw new UsageError("board set needs a title, progress or sections")
      return json(await setSessionBoard(owner, content))
    }
    case "progress": {
      const owner = await boardOwner(inv, "progress")
      const progress = parseBoardProgress(args.positionals[0])
      if (!progress) throw new UsageError("board progress needs DONE/TOTAL, such as 35/99")
      return json(await setSessionBoardProgress(owner, progress))
    }
    case "get": {
      const id = args.positionals[0] ?? inv.callerSessionId
      if (!id) throw new UsageError("board get needs a session id outside a Cogpit session")
      await requireSessionAccess(inv, id)
      return json((await sessionBoard(id)) ?? { sessionId: id, board: null })
    }
    case "clear": {
      const owner = await boardOwner(inv, "clear")
      return json({ sessionId: owner, cleared: await clearSessionBoard(owner) })
    }
    default:
      throw new UsageError("board needs set, progress, get or clear")
  }
}

const COMMANDS: Record<string, (inv: CliInvocation, rest: string[]) => Promise<CliOutput>> = {
  new: newCommand,
  send: sendCommand,
  wait: waitCommand,
  status: statusCommand,
  result: resultCommand,
  receipt: receiptCommand,
  tasks: tasksCommand,
  transition: transitionCommand,
  approve: (inv, rest) => approvalCommand(inv, rest, "approve"),
  deny: (inv, rest) => approvalCommand(inv, rest, "deny"),
  answer: answerCommand,
  interrupt: interruptCommand,
  stop: stopCommand,
  children: childrenCommand,
  board: boardCommand,
  fetch: fetchCommand,
  discard: discardCommand,
  devices: devicesCommand,
  projects: projectsCommand,
}

export async function runSessionCli(inv: CliInvocation): Promise<CliOutput> {
  const [command, ...rest] = inv.argv
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { exitCode: command ? EXIT.ok : EXIT.error, stdout: `${USAGE}\n`, stderr: "" }
  }
  const run = COMMANDS[command]
  if (!run) return { exitCode: EXIT.error, stdout: "", stderr: `Unknown command "${command}"\n\n${USAGE}\n` }
  try {
    if (command === "new" && inv.callerSessionId) await requireSessionAccess(inv, inv.callerSessionId, true)
    return await run(inv, rest)
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: EXIT.error, stdout: "", stderr: `${error.message}\nRun "${CLI_NAME} help" for usage.\n` }
    }
    return { exitCode: EXIT.error, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` }
  }
}
