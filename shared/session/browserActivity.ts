/**
 * The agent's own browser use, read back out of the transcript.
 *
 * The Browser panel follows whichever managed browser the agent last drove and
 * captions the page with the command that drove it. Nothing writes those facts
 * back — the shim only routes the call — so both are derived here from the
 * shell tool calls of the main lane. Subagents run in throwaway browsers that
 * are invisible by design, so `subAgentActivity` is never scanned and a
 * `tmp-*` browser never surfaces.
 */
import { DEFAULT_BROWSER, isThrowawayName } from "../browser/names"
import { getCommandText } from "./toolSummary"
import type { ParsedSession, ToolCall } from "./types"

export interface BrowserAgentActivity {
  /** Managed browser the call drove: `--session <name>`, else the default one. */
  session: string
  /** The invocation, from `agent-browser` up to the first command separator. */
  command: string
  timestamp: string
  toolCallId: string
  /** False while the tool call is still running. */
  done: boolean
}

const BINARY = "agent-browser"
const MAX_COMMAND_LENGTH = 120

const SHELL_TOOL = /(?:^|[._])exec_command$/
/**
 * The binary as a word, optionally reached through a path, so
 * `/usr/local/bin/agent-browser open x` counts while `cat agent-browser-plan.md`
 * does not.
 */
const INVOCATION = /(?:^|[\s;&|(`"'])(?:[^\s;&|`"']*\/)?agent-browser(?![\w.-])/
const SEPARATOR = /&&|;|\n/
const BROWSER_FLAG = /--session(?:=|\s+)(['"]?)([^\s'"]+)\1/

function isShellCall(call: ToolCall): boolean {
  return call.name === "Bash" || SHELL_TOOL.test(call.name)
}

/** The invocation text starting at the binary, cut at the next command. */
function invocationIn(command: string): string | null {
  const match = INVOCATION.exec(command)
  if (!match) return null
  const rest = command.slice(match.index + match[0].length - BINARY.length)
  const separator = SEPARATOR.exec(rest)
  return (separator ? rest.slice(0, separator.index) : rest).trim()
}

function browserOf(invocation: string): string {
  return BROWSER_FLAG.exec(invocation)?.[2] ?? DEFAULT_BROWSER
}

function activityOf(call: ToolCall): BrowserAgentActivity | null {
  if (!isShellCall(call)) return null
  const invocation = invocationIn(getCommandText(call.input))
  if (invocation === null) return null
  const browser = browserOf(invocation)
  if (isThrowawayName(browser)) return null
  return {
    session: browser,
    command: invocation.length > MAX_COMMAND_LENGTH
      ? `${invocation.slice(0, MAX_COMMAND_LENGTH - 1)}…`
      : invocation,
    timestamp: call.timestamp,
    toolCallId: call.id,
    done: call.result !== null,
  }
}

/**
 * The newest visible `agent-browser` call in the session, or null. A throwaway
 * call is skipped rather than ending the scan, so a subagent working in the
 * background cannot hide the browser the main agent is driving.
 */
export function latestBrowserActivity(session: ParsedSession | null): BrowserAgentActivity | null {
  const turns = session?.turns ?? []
  for (let turn = turns.length - 1; turn >= 0; turn--) {
    const calls = turns[turn].toolCalls
    for (let index = calls.length - 1; index >= 0; index--) {
      const activity = activityOf(calls[index])
      if (activity) return activity
    }
  }
  return null
}
