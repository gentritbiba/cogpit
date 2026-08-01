import { diffLineCount } from "@/lib/diffUtils"
import type { ToolCall } from "@/lib/types"

/**
 * Mirrors the one-line activity summary Claude Code renders for a collapsed
 * group of tool calls, e.g.
 *
 *   Made 1 scratchpad edit +68, read 1 file, ran 2 shell commands
 *
 * None of this is persisted in the JSONL transcript — the CLI derives it at
 * render time, so we recompute it from the parsed tool calls.
 */

export interface ActivityClause {
  key: string
  /** Lowercase clause text; the first clause is capitalized when formatted. */
  text: string
  added?: number
  removed?: number
}

export interface ActivitySummary {
  clauses: ActivityClause[]
}

export type ShellCommandKind = "search" | "read" | "list" | "shell"

// ── Shell command classification ───────────────────────────────────────────
// Command allowlists match Claude Code 2.1.220. A command counts as read-only
// only when *every* non-neutral segment is in one of these sets.

const NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"])
const SEARCH_COMMANDS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"])
const READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "stat", "file",
  "strings", "jq", "awk", "cut", "sort", "uniq", "tr",
])
const LIST_COMMANDS = new Set(["ls", "tree", "du"])

/** Split a shell command into its simple commands (pipes, lists, sequences). */
function splitShellSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Classify a shell command as read-only (search/read/list) or a real command.
 * Any segment outside the allowlists disqualifies the entire command.
 */
export function classifyShellCommand(command: string): ShellCommandKind {
  const segments = splitShellSegments(command)
  let search = false
  let read = false
  let list = false
  let sawCommand = false

  for (const segment of segments) {
    const head = segment.split(/\s+/)[0]
    if (!head || NEUTRAL_COMMANDS.has(head)) continue
    sawCommand = true
    if (SEARCH_COMMANDS.has(head)) search = true
    else if (READ_COMMANDS.has(head)) read = true
    else if (LIST_COMMANDS.has(head)) list = true
    else return "shell"
  }

  if (!sawCommand) return "shell"
  if (list) return "list"
  if (search) return "search"
  if (read) return "read"
  return "shell"
}

// ── Scratchpad detection ───────────────────────────────────────────────────

/**
 * Session scratchpad files live at
 * `<tmp>/claude-<uid>/<sanitized-cwd>/<sessionId>/scratchpad/…`
 * (`claude` without the uid suffix on Windows).
 */
const SCRATCHPAD_PATH = /[\\/]claude(?:-\d+)?[\\/](?:[^\\/]+[\\/])+scratchpad[\\/]/i

export function isScratchpadPath(path: string): boolean {
  return SCRATCHPAD_PATH.test(path)
}

// ── Categorization ─────────────────────────────────────────────────────────

const SEARCH_TOOLS = new Set(["Grep", "Glob"])
const SHELL_TOOLS = new Set(["Bash", "PowerShell"])
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"])
const AGENT_TOOLS = new Set(["Task", "Agent"])

function toolPath(input: Record<string, unknown>): string | null {
  const path = input.file_path ?? input.path
  return typeof path === "string" ? path : null
}

function toolCommand(input: Record<string, unknown>): string | null {
  return typeof input.command === "string" ? input.command : null
}

/** Server name out of an `mcp__<server>__<tool>` tool name, if it is one. */
function mcpServerName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null
  const server = toolName.split("__")[1]
  if (!server) return null
  return server.replace(/^claude[._]ai[._]/i, "").replace(/_/g, " ")
}

/** Lines added/removed by a single edit-family tool call. */
function editLineDelta(
  name: string,
  input: Record<string, unknown>,
): { added: number; removed: number } {
  if (Array.isArray(input.edits)) {
    let added = 0
    let removed = 0
    for (const edit of input.edits) {
      if (!edit || typeof edit !== "object") continue
      const { old_string: oldStr, new_string: newStr } = edit as Record<string, unknown>
      const delta = diffLineCount(
        typeof oldStr === "string" ? oldStr : "",
        typeof newStr === "string" ? newStr : "",
      )
      added += delta.add
      removed += delta.del
    }
    return { added, removed }
  }

  const before = name === "Edit" && typeof input.old_string === "string" ? input.old_string : ""
  const after =
    typeof input.new_string === "string"
      ? input.new_string
      : typeof input.content === "string"
        ? input.content
        : typeof input.new_source === "string"
          ? input.new_source
          : ""
  const delta = diffLineCount(before, after)
  return { added: delta.add, removed: delta.del }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** `12s`, `1m 35s` — matches the CLI's duration rendering for this line. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
}

// ── Summary ────────────────────────────────────────────────────────────────

export interface SummarizeOptions {
  /** Total time spent in thinking blocks in the group, in milliseconds. */
  thoughtForMs?: number
}

export function summarizeActivity(
  toolCalls: ToolCall[],
  options: SummarizeOptions = {},
): ActivitySummary {
  const editedFiles = new Set<string>()
  const readFiles = new Set<string>()
  const mcpServers = new Set<string>()
  let editAdded = 0
  let editRemoved = 0
  let scratchpadCount = 0
  let scratchpadAdded = 0
  let scratchpadRemoved = 0
  let searchCount = 0
  let readOperations = 0
  let listCount = 0
  let mcpCount = 0
  let agentCount = 0
  let otherCount = 0
  let shellCount = 0

  for (const tc of toolCalls) {
    const server = mcpServerName(tc.name)
    if (server) {
      mcpCount += 1
      mcpServers.add(server)
      continue
    }

    if (EDIT_TOOLS.has(tc.name)) {
      const path = toolPath(tc.input)
      const delta = editLineDelta(tc.name, tc.input)
      if (path && isScratchpadPath(path)) {
        scratchpadCount += 1
        scratchpadAdded += delta.added
        scratchpadRemoved += delta.removed
      } else {
        editedFiles.add(path ?? tc.id)
        editAdded += delta.added
        editRemoved += delta.removed
      }
      continue
    }

    if (tc.name === "Read") {
      const path = toolPath(tc.input)
      if (path) readFiles.add(path)
      else readOperations += 1
      continue
    }

    if (SEARCH_TOOLS.has(tc.name)) {
      searchCount += 1
      continue
    }

    if (SHELL_TOOLS.has(tc.name)) {
      const command = toolCommand(tc.input)
      switch (command === null ? "shell" : classifyShellCommand(command)) {
        case "search":
          searchCount += 1
          break
        case "list":
          listCount += 1
          break
        case "read":
          readOperations += 1
          break
        default:
          shellCount += 1
      }
      continue
    }

    if (AGENT_TOOLS.has(tc.name)) {
      agentCount += 1
      continue
    }

    otherCount += 1
  }

  const readCount = readFiles.size > 0 ? readFiles.size : readOperations
  const clauses: ActivityClause[] = []
  const push = (key: string, text: string, added = 0, removed = 0) => {
    clauses.push(added > 0 || removed > 0 ? { key, text, added, removed } : { key, text })
  }

  // Clause order mirrors the CLI's fixed ordering.
  const thoughtForMs = options.thoughtForMs ?? 0
  if (thoughtForMs > 0) push("thought", `thought for ${formatDuration(thoughtForMs)}`)
  if (editedFiles.size > 0)
    push("edit", `edited ${plural(editedFiles.size, "file")}`, editAdded, editRemoved)
  if (scratchpadCount > 0)
    push(
      "scratchpad",
      `made ${scratchpadCount} scratchpad ${scratchpadCount === 1 ? "edit" : "edits"}`,
      scratchpadAdded,
      scratchpadRemoved,
    )
  if (searchCount > 0) push("search", `searched for ${plural(searchCount, "pattern")}`)
  if (readCount > 0) push("read", `read ${plural(readCount, "file")}`)
  if (listCount > 0) push("list", `listed ${plural(listCount, "directory", "directories")}`)
  if (mcpCount > 0) {
    const names = [...mcpServers].join(", ") || "MCP"
    push("mcp", mcpCount > 1 ? `called ${names} ${mcpCount} times` : `called ${names}`)
  }
  if (agentCount > 0) push("agent", `ran ${plural(agentCount, "agent")}`)
  if (otherCount > 0) push("other", `called ${plural(otherCount, "tool")}`)
  if (shellCount > 0) push("bash", `ran ${shellCount} shell ${shellCount === 1 ? "command" : "commands"}`)

  return { clauses }
}

/** Render a summary as the CLI's plain sentence (first clause capitalized). */
export function formatActivitySummary(summary: ActivitySummary): string {
  return summary.clauses
    .map((clause, i) => {
      const text = i === 0 ? clause.text[0].toUpperCase() + clause.text.slice(1) : clause.text
      const added = clause.added ? ` +${clause.added}` : ""
      const removed = clause.removed ? ` -${clause.removed}` : ""
      return `${text}${added}${removed}`
    })
    .join(", ")
}
