/**
 * What a shell command did to a crew. A lead drives its crew with the
 * `cogpit-session` CLI from Bash, so its transcript is a run of shell
 * commands; this reads them back as what they were: starting sessions,
 * messaging them, waiting on them, answering and stopping them.
 */

import { shortenModel } from "../../shared/session/model-names"
import { getCommandText } from "../../shared/session/toolSummary"
import { AGENT_KINDS, descriptorFor } from "@/lib/agents"

export type CrewVerb =
  | "new" | "send" | "approve" | "deny" | "answer" | "stop" | "interrupt"
  | "wait" | "result" | "status" | "children" | "tasks" | "fetch" | "discard" | "transition" | "receipt"

/** Verbs by how much they change, so a command that sends and waits reads as a send. */
const WEIGHT: Record<CrewVerb, number> = {
  new: 10, send: 9, approve: 8, deny: 8, answer: 8, stop: 7, interrupt: 7, discard: 7, transition: 6, fetch: 5,
  wait: 4, result: 3, status: 2, children: 2, tasks: 2, receipt: 1,
}

const VALUE_FLAGS = new Set([
  "name", "agent", "model", "effort", "mode", "worktree", "device", "cwd", "timeout", "command-id", "request",
  "feedback", "json", "instance", "questions", "turn", "ack", "cancel", "target", "revision", "message", "session",
])

export interface CrewInvocation {
  verb: CrewVerb
  args: string[]
  flags: Record<string, string>
  switches: string[]
  /** Where in the command the invocation's words begin, just after `cogpit-session`. */
  at: number
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function isVerb(word: string): word is CrewVerb {
  return word in WEIGHT
}

/**
 * The words of one invocation, from just after its verb to the end of that
 * command: quotes are unwrapped, `$(…)` kept whole, and redirections,
 * pipes, separators and an unbalanced `)` end it.
 */
function wordsFrom(command: string, start: number): string[] {
  const words: string[] = []
  let word = ""
  let quote: "'" | "\"" | null = null
  let depth = 0
  const flush = () => {
    if (word) words.push(word)
    word = ""
  }
  for (let index = start; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = null
      else word += char
      continue
    }
    if (char === "$" && command[index + 1] === "(") {
      depth++
      word += "$("
      index++
      continue
    }
    if (depth > 0) {
      if (char === "(") depth++
      if (char === ")") depth--
      word += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (char === " " || char === "\t") {
      flush()
      continue
    }
    if ("\n;&|<>)`".includes(char)) {
      // `2>&1`: the digits name a file descriptor, not an argument.
      if ((char === "<" || char === ">") && /^\d+$/.test(word)) word = ""
      break
    }
    if (char === "\\" && command[index + 1] === "\n") {
      index++
      continue
    }
    word += char
  }
  flush()
  return words
}

/** Words after which the next word is still a command: `until`, `if`, `nohup`… */
const PREFIX_WORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "!", "exec", "nohup", "env", "sudo", "command", "{"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

type Mode = "code" | "single" | "double" | "substitution" | "subshell"

/**
 * Where each command word of a shell command ends, with the word: the first
 * word of every simple command, inside `$(…)` and subshells too. Quoted
 * text, comments and heredoc bodies are skipped, so a command that only
 * mentions another command is never read as running it.
 */
function commandWords(command: string): Array<{ word: string; end: number }> {
  const found: Array<{ word: string; end: number }> = []
  const stack: Array<{ mode: Mode; atStart: boolean; word: string | null }> = [{ mode: "code", atStart: true, word: null }]
  const heredocs: string[] = []
  const frame = () => stack[stack.length - 1]!
  const finishWord = (end: number) => {
    const current = frame()
    if (current.word === null) return
    const word = current.word
    current.word = null
    if (ASSIGNMENT.test(word) || PREFIX_WORDS.has(word)) return
    current.atStart = false
    found.push({ word, end })
  }
  const startsCommand = () => {
    const current = frame()
    current.word = null
    current.atStart = true
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const current = frame()
    if (current.mode === "single" || current.mode === "double") {
      // Quoted text is never a command, but it can spell one: "$HOME/…/cogpit-session".
      const outer = stack[stack.length - 2]!
      if (char === (current.mode === "single" ? "'" : "\"")) stack.pop()
      else if (current.mode === "double" && char === "\\") index++
      else if (current.mode === "double" && char === "$" && command[index + 1] === "(") {
        stack.push({ mode: "substitution", atStart: true, word: null })
        index++
      } else if (outer.word !== null) outer.word += char
      continue
    }
    if (char === "\n") {
      finishWord(index)
      startsCommand()
      // A heredoc's body starts on the next line and runs to its delimiter.
      while (heredocs.length > 0) {
        const delimiter = heredocs.shift()!
        let lineEnd = command.indexOf("\n", index + 1)
        while (lineEnd !== -1 && command.slice(index + 1, lineEnd).trim() !== delimiter) {
          index = lineEnd
          lineEnd = command.indexOf("\n", index + 1)
        }
        index = lineEnd === -1 ? command.length : lineEnd
      }
      continue
    }
    if (char === " " || char === "\t") { finishWord(index); continue }
    if (char === "\\") {
      const next = command[index + 1]
      if (next !== undefined && next !== "\n" && current.atStart) current.word = (current.word ?? "") + next
      index++
      continue
    }
    if (char === "#" && current.word === null) {
      const lineEnd = command.indexOf("\n", index)
      index = (lineEnd === -1 ? command.length : lineEnd) - 1
      continue
    }
    if (char === "'" || char === "\"") {
      if (current.atStart && current.word === null) current.word = ""
      stack.push({ mode: char === "'" ? "single" : "double", atStart: false, word: null })
      continue
    }
    if (char === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
      stack.push({ mode: "substitution", atStart: true, word: null })
      index++
      continue
    }
    if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      finishWord(index)
      const match = /^<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(index))
      if (match) {
        heredocs.push(match[2]!)
        index += match[0].length - 1
      }
      continue
    }
    if (char === ")") {
      finishWord(index)
      if (current.mode === "substitution" || current.mode === "subshell") stack.pop()
      continue
    }
    if (char === "(") {
      finishWord(index)
      stack.push({ mode: "subshell", atStart: true, word: null })
      continue
    }
    if (";&|`".includes(char)) {
      finishWord(index)
      startsCommand()
      continue
    }
    if ("<>".includes(char)) { finishWord(index); continue }
    if (current.atStart) current.word = (current.word ?? "") + char
  }
  finishWord(command.length)
  return found
}

/** Every `cogpit-session` invocation in a command, in order. */
export function parseCrewInvocations(command: string): CrewInvocation[] {
  const invocations: CrewInvocation[] = []
  for (const { word, end } of commandWords(command)) {
    if (word.split("/").at(-1) !== "cogpit-session") continue
    const [verb, ...rest] = wordsFrom(command, end)
    if (!verb || !isVerb(verb)) continue
    const words = rest
    const invocation: CrewInvocation = { verb, args: [], flags: {}, switches: [], at: end }
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!
      if (!word.startsWith("--")) {
        invocation.args.push(word)
        continue
      }
      const [flag, inline] = word.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
      if (inline !== undefined) invocation.flags[flag] = inline
      else if (VALUE_FLAGS.has(flag) && index + 1 < words.length) invocation.flags[flag] = words[++index]!
      else invocation.switches.push(flag)
    }
    invocations.push(invocation)
  }
  return invocations
}

/** The `cogpit-session new` invocations in a command, in the order they start their sessions. */
export function crewStarts(command: string): CrewInvocation[] {
  return parseCrewInvocations(command).filter((invocation) => invocation.verb === "new")
}

export interface CrewCall {
  verb: CrewVerb
  /** How many invocations of that verb the command ran. */
  count: number
  /** The sessions it acted on, or for a start the sessions it started, by id. */
  sessionIds: string[]
  /** The names sessions were started with. */
  names: string[]
  /** For a single start: model, effort, worktree, machine, read-only. */
  details: string[]
  outcomes: { finished: number; needsInput: number; failed: number; running: number }
  /** `stop --children`: every session the caller started. */
  everyChild: boolean
  /** `approve --always`. */
  always: boolean
}

function ids(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const scoped = value.match(/i-[A-Za-z0-9-]+__[A-Za-z0-9_-]+/g) ?? []
    const native = value.replace(/i-[A-Za-z0-9-]+__[A-Za-z0-9_-]+/g, "").match(SESSION_ID) ?? []
    return [...scoped, ...native.map((id) => id.toLowerCase())]
  }))]
}

/** The top-level JSON objects in a command's output, in the order it printed them. */
function printedObjects(output: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = []
  let depth = 0
  let begin = -1
  let inString = false
  for (let index = 0; index < output.length; index++) {
    const char = output[index]
    if (inString) {
      if (char === "\\") index++
      else if (char === "\"") inString = false
    } else if (char === "\"") {
      if (depth > 0) inString = true
    } else if (char === "{") {
      if (depth++ === 0) begin = index
    } else if (char === "}" && depth > 0 && --depth === 0) {
      try {
        const value: unknown = JSON.parse(output.slice(begin, index + 1))
        if (value && typeof value === "object" && !Array.isArray(value)) objects.push(value as Record<string, unknown>)
      } catch { /* not JSON; another program's braces */ }
    }
  }
  return objects
}

/**
 * The session each start in a command opened, one slot per `new` in the
 * order they appear, undefined where that cannot be known for sure. A
 * start prints the session with its `dirName` and the wait that follows
 * it. A `--wait` start prints a report instead, which looks like a
 * `status` or `wait` report, so reports count only in a command that ran
 * no other verb. Each kind is matched to its starts in order, and only
 * when the output holds exactly one per start; otherwise those starts stay
 * unlinked rather than name the wrong session.
 */
export function startedIds(result: string | null, command: string): Array<string | undefined> {
  const invocations = parseCrewInvocations(command)
  const starts = invocations.filter((invocation) => invocation.verb === "new")
  if (!result || starts.length === 0) return []
  const onlyStarts = starts.length === invocations.length
  const plain: string[] = []
  const reports: string[] = []
  for (const printed of printedObjects(result)) {
    const sessionId = typeof printed.sessionId === "string" ? ids([printed.sessionId])[0] : undefined
    if (!sessionId || plain.includes(sessionId) || reports.includes(sessionId)) continue
    if ("dirName" in printed && "next" in printed && !("outcome" in printed)) plain.push(sessionId)
    else if (onlyStarts && "outcome" in printed) reports.push(sessionId)
  }
  const blocking = starts.filter((start) => start.switches.includes("wait")).length
  const plainIds = plain.length === starts.length - blocking ? plain : []
  const reportIds = reports.length === blocking ? reports : []
  return starts.map((start) => (start.switches.includes("wait") ? reportIds : plainIds).shift())
}

/** What a start asked for besides its message: model, effort, worktree, machine, read-only. */
export function startDetails({ flags }: CrewInvocation): string[] {
  const agent = AGENT_KINDS.find((kind) => kind === flags.agent)
  return [
    flags.model ? shortenModel(flags.model) : agent ? descriptorFor(agent).displayName : null,
    flags.effort ?? null,
    flags.worktree ? `worktree ${flags.worktree}` : null,
    flags.device ? `on ${flags.device}` : null,
    flags.mode === "plan" ? "read-only" : null,
  ].filter((detail): detail is string => Boolean(detail))
}

function outcomesIn(result: string | null): CrewCall["outcomes"] {
  const count = (outcome: string) => (result?.match(new RegExp(`"outcome"\\s*:\\s*"${outcome}"`, "g")) ?? []).length
  return { finished: count("completed"), needsInput: count("needs_input"), failed: count("error"), running: count("running") }
}

/** What a shell command did to a crew; null when it ran no crew verb. */
export function describeCrewCall(command: string, result: string | null): CrewCall | null {
  const invocations = parseCrewInvocations(command)
  if (invocations.length === 0) return null
  const verb = invocations.reduce((best, { verb: next }) => (WEIGHT[next] > WEIGHT[best] ? next : best), invocations[0]!.verb)
  const chosen = invocations.filter((invocation) => invocation.verb === verb)
  const started = verb === "new" ? startedIds(result, command).filter((sessionId): sessionId is string => sessionId !== undefined) : []
  return {
    verb,
    count: chosen.length,
    sessionIds: verb === "new" ? started : ids(chosen.flatMap((invocation) => verb === "send" || verb === "answer" ? invocation.args.slice(0, 1) : invocation.args)),
    names: chosen.flatMap((invocation) => (invocation.flags.name ? [invocation.flags.name] : [])),
    details: chosen.length === 1 && verb === "new" ? startDetails(chosen[0]!) : [],
    outcomes: verb === "wait" || (verb === "new" && chosen.some((invocation) => invocation.switches.includes("wait")))
      ? outcomesIn(result)
      : { finished: 0, needsInput: 0, failed: 0, running: 0 },
    everyChild: chosen.some((invocation) => invocation.switches.includes("children")),
    always: chosen.some((invocation) => invocation.switches.includes("always")),
  }
}

function sessions(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`
}

/** The call as a line: "Started w3-perf-ship · Opus 5.5", "Waited on 2 sessions · 1 finished". */
export function crewCallSentence(call: CrewCall, nameOf: (sessionId: string) => string | undefined): string {
  const named = (id: string) => nameOf(id) ?? id.slice(0, 8)
  const target = call.sessionIds.length === 1 ? named(call.sessionIds[0]!) : null
  const many = sessions(Math.max(call.sessionIds.length, call.count))
  const outcomes = [
    call.outcomes.finished && `${call.outcomes.finished} finished`,
    call.outcomes.needsInput && `${call.outcomes.needsInput} ${call.outcomes.needsInput === 1 ? "needs" : "need"} input`,
    call.outcomes.failed && `${call.outcomes.failed} failed`,
    call.outcomes.running && `${call.outcomes.running} still running`,
  ].filter(Boolean)
  const withOutcomes = (line: string) => [line, ...outcomes].join(" · ")

  switch (call.verb) {
    case "new": {
      if (call.count > 1) return withOutcomes(`Started ${sessions(call.count)}`)
      const name = call.names[0] ?? (call.sessionIds[0] ? nameOf(call.sessionIds[0]) : undefined) ?? "a session"
      return withOutcomes([`Started ${name}`, ...call.details].join(" · "))
    }
    case "send": return `Messaged ${target ?? many}`
    case "wait": return withOutcomes(`Waited on ${target ?? many}`)
    case "approve": return `Approved ${target ? `${target}'s` : "a"} request${call.always ? " for the rest of its session" : ""}`
    case "deny": return `Denied ${target ? `${target}'s` : "a"} request`
    case "answer": return `Answered ${target ?? "a question"}`
    case "stop": return call.everyChild ? "Stopped every session it started" : `Stopped ${target ?? many}`
    case "interrupt": return `Interrupted ${target ?? many}`
    case "result": return target ? `Read ${target}'s result` : `Read ${many}' results`
    case "status": return `Checked on ${target ?? many}`
    case "children": return "Listed the sessions it started"
    case "tasks": return "Read its delegated results"
    case "fetch": return `Brought ${target ? `${target}'s` : "its"} work back`
    case "discard": return `Discarded ${target ?? many}`
    case "transition": return `Handed ${target ?? "a session"} to another provider`
    case "receipt": return "Checked a delivery"
  }
}

interface Heredoc {
  /** Where its `<<` is in the command. */
  at: number
  /** The file it was written to, when it was. */
  target: string | null
  body: string
}

/** Every heredoc in a command, in order. */
function heredocs(command: string): Heredoc[] {
  const found: Heredoc[] = []
  const opener = /<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1([^\n]*)\n/g
  for (let match = opener.exec(command); match; match = opener.exec(command)) {
    const lineStart = command.lastIndexOf("\n", match.index) + 1
    const line = command.slice(lineStart, match.index) + match[3]
    const target = /(?:^|[^<>&\d])>\s*([^\s;|&<>]+)/.exec(line)?.[1] ?? null
    const lines = command.slice(match.index + match[0].length).split("\n")
    const end = lines.findIndex((value) => value.trim() === match![2])
    found.push({ at: match.index, target: target ? unquote(target) : null, body: lines.slice(0, end === -1 ? undefined : end).join("\n").trim() })
    if (end !== -1) opener.lastIndex = match.index + match[0].length + lines.slice(0, end + 1).join("\n").length
  }
  return found
}

function unquote(word: string): string {
  return word.replace(/^['"]|['"]$/g, "")
}

/**
 * What an invocation reads from stdin, from its own line: a heredoc it
 * opens (`new - <<EOF`), a file it redirects in (`new - < brief.md`) that
 * the command wrote earlier with a heredoc, or a heredoc piped into it
 * (`cat <<EOF | cogpit-session new -`).
 */
function stdinBrief(invocation: CrewInvocation, command: string, bodies: readonly Heredoc[]): string {
  const lineStart = command.lastIndexOf("\n", invocation.at) + 1
  const lineEnd = command.indexOf("\n", invocation.at) === -1 ? command.length : command.indexOf("\n", invocation.at)
  const own = bodies.find((body) => body.at >= invocation.at && body.at < lineEnd)
  if (own) return own.body
  const file = /(?<!<)<(?!<)\s*([^\s;|&<>]+)/.exec(command.slice(invocation.at, lineEnd))?.[1]
  if (file) return fileBrief(unquote(file), invocation, bodies)
  return bodies.findLast((body) => body.target === null && body.at >= lineStart && body.at < invocation.at)?.body ?? ""
}

/** The brief a command wrote to `file` with a heredoc before the invocation that reads it. */
function fileBrief(file: string, invocation: CrewInvocation, bodies: readonly Heredoc[]): string {
  return bodies.findLast((body) => body.target === file && body.at < invocation.at)?.body ?? ""
}

/**
 * The message a start was given, as the agent will read it: a heredoc's
 * body rather than the shell around it, including a brief the same command
 * wrote to a file and then fed in. A brief from anywhere else comes back
 * empty.
 */
export function startMessage(invocation: CrewInvocation, command: string): string {
  const message = invocation.args.join(" ").trim()
  const inline = /^\$\(\s*cat\s+<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*\)?$/.exec(message)
  if (inline) return inline[3]!.trim()
  if (message !== "-" && !message.startsWith("$(")) return message
  const bodies = heredocs(command)
  if (message === "-") return stdinBrief(invocation, command, bodies)
  const file = /^\$\(\s*cat\s+([^\s)]+)\s*\)$/.exec(message)?.[1]
  return file ? fileBrief(unquote(file), invocation, bodies) : ""
}

/** Whether a tool call started crew sessions with `cogpit-session new`. */
export function startsCrewSession(toolCall: { input: Record<string, unknown>; result: string | null }): boolean {
  const command = getCommandText(toolCall.input)
  return command.includes("cogpit-session") && describeCrewCall(command, toolCall.result)?.verb === "new"
}
