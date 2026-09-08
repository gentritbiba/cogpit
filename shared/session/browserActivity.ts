/**
 * The agent's own browser use, read back out of the transcript.
 *
 * The Browser panel follows whichever managed browser the agent last drove and
 * captions the page with the command that drove it. Nothing writes those facts
 * back — the shim only routes the call — so both are derived here from the
 * shell tool calls of the main lane, whether the agent recorded one per call or
 * wrapped a whole script of them in one. Subagents run in throwaway browsers
 * that are invisible by design, so `subAgentActivity` is never scanned and a
 * `tmp-*` browser never surfaces.
 */
import { findBrowserInvocations } from "../browser/invocation"
import { isThrowawayName } from "../browser/names"
import { expandToolScript } from "./agents"
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

const MAX_COMMAND_LENGTH = 120

const SHELL_TOOL = /(?:^|[._])exec_command$/

function isShellName(name: string): boolean {
  return name === "Bash" || SHELL_TOOL.test(name)
}

/** The shell commands a call ran, in the order it ran them. */
function shellCommands(call: ToolCall): string[] {
  return expandToolScript(call)
    .filter((inner) => isShellName(inner.name))
    .map((inner) => getCommandText(inner.input))
}

function activityOf(call: ToolCall): BrowserAgentActivity | null {
  for (const command of shellCommands(call)) {
    const [invocation] = findBrowserInvocations(command)
    if (invocation === undefined || isThrowawayName(invocation.browser)) continue
    const { text } = invocation
    return {
      session: invocation.browser,
      command: text.length > MAX_COMMAND_LENGTH ? `${text.slice(0, MAX_COMMAND_LENGTH - 1)}…` : text,
      timestamp: call.timestamp,
      toolCallId: call.id,
      done: call.result !== null,
    }
  }
  return null
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
