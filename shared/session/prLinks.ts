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
  /**
   * Tool call that opened the pull request, for jumping back to it. Empty for
   * pull requests the transcript names outright, which belong to no tool call.
   */
  toolCallId: string
  timestamp: string
}

/** A pull request a session explicitly opened or addressed with GitHub tooling. */
export interface SessionPullRequestReference {
  number: number
  /** `owner/repo` when the command or URL names it. */
  repo: string
}

/** `/pull/new/<branch>` compare links are excluded by requiring a numeric id. */
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/

/**
 * Matches `gh pr create` only in command position — after a separator, the
 * start of the string, or an env assignment — so a command that merely quotes
 * the phrase (`grep "gh pr create"`) is not mistaken for an invocation.
 */
const CREATE_INVOCATION = /(?:^|[\n;&|(`])[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*gh[ \t]+pr[ \t]+create\b/
const TARGET_INVOCATION = /(?:^|[\n;&|(`])[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*gh[ \t]+pr[ \t]+(?:view|checkout|diff|checks|edit|merge|close|reopen|comment|review|ready)\b([^\n;&|)]*)/
const REPO_FLAG = /(?:^|\s)(?:--repo|-R)(?:=|\s+)([\w.-]+\/[\w.-]+)/
const TARGET_NUMBER = /(?:^|\s)#?(\d+)(?=\s|$)/

const TITLE_FLAG = String.raw`(?:--title|(?:^|\s)-t)(?:=|\s+)`
const TITLE_PATTERNS = [
  new RegExp(`${TITLE_FLAG}"((?:[^"\\\\]|\\\\.)*)"`),
  new RegExp(`${TITLE_FLAG}'([^']*)'`),
  new RegExp(`${TITLE_FLAG}(\\S+)`),
]

/**
 * Cheap pre-filter: a line can only matter if it holds one half of the pair or
 * is a native `pr-link` record, whose url may be neither GitHub nor a `/pull/`.
 */
const GH_PR_HINT = "gh pr "
const URL_HINT = "/pull/"
const PR_LINK_HINT = "pr-link"

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
  if (Array.isArray(raw)) {
    const parts = raw.filter((part): part is string => typeof part === "string")
    return [parts.join(" "), ...parts]
  }

  const source = input.source
  if (typeof source !== "string") return []
  const commands: string[] = []
  const jsonCommand = /(?:["'](?:cmd|command)["']|\b(?:cmd|command))\s*:\s*"((?:\\.|[^"\\])*)"/g
  for (const match of source.matchAll(jsonCommand)) {
    try {
      commands.push(JSON.parse(`"${match[1]}"`))
    } catch { /* skip malformed embedded strings */ }
  }
  const templateCommand = /(?:["'](?:cmd|command)["']|\b(?:cmd|command))\s*:\s*`([^`]*)`/g
  for (const match of source.matchAll(templateCommand)) commands.push(match[1])
  return commands
}

/** The candidate that actually invokes `gh pr create`, or null if none does. */
function findCreateCommand(input: Record<string, unknown>): string | null {
  return commandCandidates(input).find((candidate) => CREATE_INVOCATION.test(candidate)) ?? null
}

function findPullRequestReference(input: Record<string, unknown>): SessionPullRequestReference | null {
  for (const candidate of commandCandidates(input)) {
    const invocation = TARGET_INVOCATION.exec(candidate)
    if (!invocation) continue
    const url = PR_URL.exec(invocation[1])
    if (url) return { number: Number(url[3]), repo: `${url[1]}/${url[2]}` }
    const number = TARGET_NUMBER.exec(invocation[1])
    if (!number) continue
    return {
      number: Number(number[1]),
      repo: REPO_FLAG.exec(invocation[1])?.[1] ?? "",
    }
  }
  return null
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
  /** Records an already-identified pull request, once. */
  add(pullRequest: SessionPullRequest): void
}

function createCollector(): Collector {
  const pullRequests: SessionPullRequest[] = []
  const seen = new Set<string>()

  function add(pullRequest: SessionPullRequest) {
    if (seen.has(pullRequest.url)) return
    seen.add(pullRequest.url)
    pullRequests.push(pullRequest)
  }

  return {
    pullRequests,
    add,
    record(output, command, toolCallId, timestamp) {
      const match = PR_URL.exec(output)
      if (!match) return
      add({
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
 * anywhere else in the transcript is a reference, not a creation. Native
 * `pr-link` records carry no message and so never reach a turn; only the raw
 * scanner below sees them.
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
  /** Pull requests explicitly addressed by the session, including created PRs. */
  readonly references: SessionPullRequestReference[]
}

/** Text of a tool result, which may be a plain string or a list of blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("\n")
  }
  if (isRecord(content)) {
    return resultText(
      content.detailedContent
      ?? content.content
      ?? content.contents
      ?? content.output,
    )
  }
  return ""
}

export function createPullRequestScanner(): PullRequestScanner {
  const collector = createCollector()
  const references: SessionPullRequestReference[] = []
  const seenReferences = new Set<string>()
  /** tool call id → the create command, awaiting the output that names the PR. */
  const openCreates = new Map<string, { command: string; timestamp: string }>()
  let remainder = ""

  function recordReference(reference: SessionPullRequestReference) {
    const key = `${reference.repo.toLowerCase()}#${reference.number}`
    if (seenReferences.has(key)) return
    seenReferences.add(key)
    references.push(reference)
  }

  function recordToolCall(id: unknown, input: Record<string, unknown>, timestamp: string) {
    const reference = findPullRequestReference(input)
    if (reference) recordReference(reference)
    recordCreate(id, input, timestamp)
  }

  function recordCreate(id: unknown, input: Record<string, unknown>, timestamp: string) {
    if (typeof id !== "string" || !id) return
    const command = findCreateCommand(input)
    if (command) openCreates.set(id, { command, timestamp })
  }

  /**
   * Claude writes a `pr-link` record for every pull request it opens, however it
   * was opened. The url is authoritative and is used as given — running it
   * through the GitHub-only `PR_URL` would drop GitLab merge requests.
   */
  function recordPrLink(record: Record<string, unknown>, timestamp: string) {
    const url = record.prUrl
    const number = record.prNumber
    if (typeof url !== "string" || !url) return
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return
    const repo = typeof record.prRepository === "string" ? record.prRepository : ""
    collector.add({
      url,
      number,
      repo,
      title: null,
      isDraft: false,
      toolCallId: "",
      timestamp,
    })
    recordReference({ number, repo })
  }

  function recordResult(id: unknown, output: unknown, isError: boolean) {
    if (typeof id !== "string") return
    const create = openCreates.get(id)
    if (!create || isError) return
    const text = resultText(output)
    collector.record(text, create.command, id, create.timestamp)
    const match = PR_URL.exec(text)
    if (match) recordReference({ number: Number(match[3]), repo: `${match[1]}/${match[2]}` })
  }

  /** Codex serializes tool arguments as a JSON string. */
  function parseArgs(raw: unknown): Record<string, unknown> {
    if (isRecord(raw)) return raw
    if (typeof raw !== "string") return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return { source: raw }
    }
  }

  function scanLine(line: string) {
    if (!line.includes(GH_PR_HINT) && !line.includes(URL_HINT) && !line.includes(PR_LINK_HINT)) {
      return
    }

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(record)) return

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : ""

    if (record.type === "pr-link") {
      recordPrLink(record, timestamp)
      return
    }

    const payload = record.payload
    if (isRecord(payload)) {
      const type = payload.type
      if (type === "function_call" || type === "custom_tool_call") {
        recordToolCall(payload.call_id, parseArgs(payload.arguments ?? payload.input), timestamp)
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        recordResult(payload.call_id, payload.output, false)
      }
      return
    }

    const data = record.data
    if (isRecord(data)) {
      if (record.type === "tool.execution_start") {
        recordToolCall(
          data.toolCallId,
          parseArgs(data.arguments ?? data.input),
          timestamp,
        )
      } else if (record.type === "tool.execution_complete") {
        recordResult(
          data.toolCallId,
          data.result ?? data.output ?? data.error,
          data.success === false || (data.error !== undefined && data.error !== null),
        )
      }
      return
    }

    const message = record.message
    if (!isRecord(message) || !Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === "tool_use" && isRecord(block.input)) {
        recordToolCall(block.id, block.input, timestamp)
      } else if (block.type === "tool_result") {
        recordResult(block.tool_use_id, block.content, block.is_error === true)
      }
    }
  }

  return {
    pullRequests: collector.pullRequests,
    references,
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
