import type { Turn } from "./types"

export interface SessionPullRequest {
  /** Canonical https link to the pull request */
  url: string
  number: number
  /** "owner/repo" */
  repo: string
  /** Title passed to `gh pr create`, when the command carried one */
  title: string | null
  isDraft: boolean
  /** Tool call that opened the pull request, for jumping back to it */
  toolCallId: string
  timestamp: string
}

/** `/pull/new/<branch>` compare links are excluded by requiring a numeric id. */
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/

/**
 * Matches `gh pr create` only in command position — after a separator, the
 * start of the string, or an env assignment — so a command that merely quotes
 * the phrase (`grep "gh pr create"`) is not mistaken for an invocation.
 */
const CREATE_INVOCATION = /(?:^|[\n;&|(`])[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*gh[ \t]+pr[ \t]+create\b/

const TITLE_FLAG = String.raw`(?:--title|(?:^|\s)-t)(?:=|\s+)`
const TITLE_PATTERNS = [
  new RegExp(`${TITLE_FLAG}"((?:[^"\\\\]|\\\\.)*)"`),
  new RegExp(`${TITLE_FLAG}'([^']*)'`),
  new RegExp(`${TITLE_FLAG}(\\S+)`),
]

/** Cheap pre-filter: a line can only matter if it holds one half of the pair. */
const CREATE_HINT = "gh pr create"
const URL_HINT = "/pull/"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Claude stores the shell command under `command`; Codex uses `cmd` or an argv
 * array. An argv array is either the command itself (`["gh","pr","create"]`) or
 * a wrapper around a script (`["bash","-lc","gh pr create …"]`), so both the
 * joined form and each element are offered as candidates.
 */
function commandCandidates(input: Record<string, unknown>): string[] {
  const raw = input.command ?? input.cmd
  if (typeof raw === "string") return [raw]
  if (!Array.isArray(raw)) return []
  const parts = raw.filter((part): part is string => typeof part === "string")
  return [parts.join(" "), ...parts]
}

/** The candidate that actually invokes `gh pr create`, or null if none does. */
function findCreateCommand(input: Record<string, unknown>): string | null {
  return commandCandidates(input).find((candidate) => CREATE_INVOCATION.test(candidate)) ?? null
}

function extractTitle(command: string): string | null {
  for (const pattern of TITLE_PATTERNS) {
    const match = pattern.exec(command)
    if (match) return match[1].replace(/\\(.)/g, "$1")
  }
  return null
}

interface Collector {
  /** Recorded pull requests, in creation order. Mutated in place. */
  readonly pullRequests: SessionPullRequest[]
  /** Records the pull request named by a create command's output, once. */
  record(output: string, command: string, toolCallId: string, timestamp: string): void
}

function createCollector(): Collector {
  const pullRequests: SessionPullRequest[] = []
  const seen = new Set<string>()

  return {
    pullRequests,
    record(output, command, toolCallId, timestamp) {
      const match = PR_URL.exec(output)
      if (!match || seen.has(match[0])) return
      seen.add(match[0])
      pullRequests.push({
        url: match[0],
        number: Number(match[3]),
        repo: `${match[1]}/${match[2]}`,
        title: extractTitle(command),
        isDraft: /(?:^|\s)--draft(?:\s|$)/.test(command),
        toolCallId,
        timestamp,
      })
    },
  }
}

/**
 * Finds the pull requests a session opened by pairing `gh pr create` commands
 * with the url the command printed. Deliberately strict: a url mentioned
 * anywhere else in the transcript is a reference, not a creation.
 */
export function extractPullRequests(turns: Turn[]): SessionPullRequest[] {
  const collector = createCollector()

  for (const turn of turns) {
    for (const toolCall of turn.toolCalls) {
      if (toolCall.isError || !toolCall.result) continue
      const command = findCreateCommand(toolCall.input)
      if (!command) continue
      collector.record(toolCall.result, command, toolCall.id, toolCall.timestamp)
    }
  }

  return collector.pullRequests
}

// -- Raw JSONL scanning --------------------------------------------------
//
// Turn-based extraction only sees the slice of the session the client has
// loaded. Servers need the whole file, and for a live session they need to
// fold in appended bytes without re-reading megabytes, so the scanner is a
// line-at-a-time state machine over both Claude and Codex transcript shapes.

export interface PullRequestScanner {
  /** Feed the next chunk of the file. Partial trailing lines are buffered. */
  scan(chunk: string): void
  /** Pull requests found so far, in creation order. */
  readonly pullRequests: SessionPullRequest[]
}

/** Text of a tool result, which may be a plain string or a list of blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n")
}

export function createPullRequestScanner(): PullRequestScanner {
  const collector = createCollector()
  /** tool call id → the create command, awaiting the output that names the PR. */
  const openCreates = new Map<string, { command: string; timestamp: string }>()
  let remainder = ""

  function recordCreate(id: unknown, input: Record<string, unknown>, timestamp: string) {
    if (typeof id !== "string" || !id) return
    const command = findCreateCommand(input)
    if (command) openCreates.set(id, { command, timestamp })
  }

  function recordResult(id: unknown, output: unknown, isError: boolean) {
    if (typeof id !== "string") return
    const create = openCreates.get(id)
    if (!create || isError) return
    collector.record(resultText(output), create.command, id, create.timestamp)
  }

  /** Codex serializes tool arguments as a JSON string. */
  function parseArgs(raw: unknown): Record<string, unknown> {
    if (isRecord(raw)) return raw
    if (typeof raw !== "string") return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  function scanLine(line: string) {
    if (!line.includes(CREATE_HINT) && !line.includes(URL_HINT)) return

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(record)) return

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : ""

    const payload = record.payload
    if (isRecord(payload)) {
      const type = payload.type
      if (type === "function_call" || type === "custom_tool_call") {
        recordCreate(payload.call_id, parseArgs(payload.arguments ?? payload.input), timestamp)
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        recordResult(payload.call_id, payload.output, false)
      }
      return
    }

    const message = record.message
    if (!isRecord(message) || !Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === "tool_use" && isRecord(block.input)) {
        recordCreate(block.id, block.input, timestamp)
      } else if (block.type === "tool_result") {
        recordResult(block.tool_use_id, block.content, block.is_error === true)
      }
    }
  }

  return {
    pullRequests: collector.pullRequests,
    scan(chunk: string) {
      const lines = (remainder + chunk).split("\n")
      remainder = lines.pop() ?? ""
      for (const line of lines) if (line) scanLine(line)
    },
  }
}

/** One-shot scan of a complete transcript. */
export function scanPullRequests(jsonlText: string): SessionPullRequest[] {
  const scanner = createPullRequestScanner()
  scanner.scan(jsonlText.endsWith("\n") ? jsonlText : `${jsonlText}\n`)
  return scanner.pullRequests
}

/**
 * Unions pull requests from several sources (a live client-side parse and a
 * whole-file server scan), keeping the first entry seen for each url.
 */
export function mergePullRequests(
  ...sources: Array<SessionPullRequest[] | undefined>
): SessionPullRequest[] {
  const byUrl = new Map<string, SessionPullRequest>()
  for (const source of sources) {
    for (const pullRequest of source ?? []) {
      if (!byUrl.has(pullRequest.url)) byUrl.set(pullRequest.url, pullRequest)
    }
  }
  return [...byUrl.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}
