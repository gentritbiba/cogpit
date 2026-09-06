/** Shared Browser-panel guidance and the SDK-only subagent redirection hook. */
import { scanBrowserInvocations } from "../../shared/browser/invocation"
import {
  isThrowawayName,
  isValidBrowserName,
  MAX_BROWSER_NAME_LENGTH,
  THROWAWAY_PREFIX,
} from "../../shared/browser/names"
import { getCommandText } from "../../shared/session/toolSummary"
import type { HookCallback } from "../agents/sdk"

/** Always in context: capabilities, collaboration, and browser ownership. */
export const BROWSER_CONTEXT_APPEND = [
  "Browser: With default or named `agent-browser` browsers, you and the user share the same tabs and page state. Cogpit's Browser panel streams a selected tab live and lets the user click, type, and navigate.",
  "Use this for live demos, testing and fixing websites, research, and authorized workflows in signed-in accounts. The user can take over a step, then you can continue. The panel and your tool can select different tabs; snapshots show what they see only when you select the same browser and tab.",
  "No `--session` means the shared `default` browser; its logins persist across sessions. Named browsers keep separate persistent profiles. Say which browser you are using and invite the user to open the Browser panel when starting browser work.",
  "For login, 2FA, or a step the user wants to do themselves, name the browser and tab, pause browser actions, and ask them to do it in the panel. Wait for their confirmation, select the handoff tab, take a fresh snapshot, then continue. Do not overwrite their interaction or ask them to paste credentials into chat.",
  "Leave the `default` browser running unless asked to close it; the user may still be using it. You cannot tell whether the panel is open or see Cogpit's layout from website snapshots.",
  "Subagents must use private `--session tmp-<id>` browsers, invisible to the user, and close them when done. Never use the user's default or named browsers from a subagent.",
  "The `cogpit-browser` skill has the full manual, including named-browser management and flags Cogpit owns.",
].join("\n")

/** The only tool carrying a shell command in the sessions this hook runs in. */
export const BROWSER_HOOK_TOOL = "Bash"

const DENIAL = "Cogpit could not rewrite this command onto a throwaway browser safely, so it did not run. "
  + "A subagent must never drive the `default` browser or a named one — those are the user's, visible in the "
  + "Browser panel, and a second agent on the same page destroys the first agent's work. Re-issue the command "
  + "as a direct `agent-browser --session tmp-<id>` call with literal arguments. Split browser work out of shell strings, expansions, or complex shell syntax."

/** The browser a subagent gets: its own id, made into a `tmp-` name. */
export function throwawayBrowserName(agentId: string): string {
  const suffix = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
  return THROWAWAY_PREFIX + suffix.slice(0, MAX_BROWSER_NAME_LENGTH - THROWAWAY_PREFIX.length)
}

function splice(command: string, start: number, end: number, text: string): string {
  return command.slice(0, start) + text + command.slice(end)
}

/**
 * `command` with every `agent-browser` call in it pointed at `agentId`'s own
 * throwaway browser. `changed: false` when they all already were, and null when
 * the command cannot be rewritten with confidence — a half-rewritten command is
 * worse than a refused one, so the caller denies instead.
 */
export function redirectToThrowaway(
  command: string,
  agentId: string,
): { command: string; changed: boolean } | null {
  const { invocations, ambiguous } = scanBrowserInvocations(command)
  if (ambiguous) return null
  const throwaway = throwawayBrowserName(agentId)
  if (!isValidBrowserName(throwaway)) return null

  let rewritten = command
  for (let index = invocations.length - 1; index >= 0; index--) {
    const { binaryEnd, browser, sessionFlag } = invocations[index]
    if (isThrowawayName(browser)) continue
    rewritten = sessionFlag === null
      ? splice(rewritten, binaryEnd, binaryEnd, ` --session ${throwaway}`)
      : splice(rewritten, sessionFlag.start, sessionFlag.end, `--session ${throwaway}`)
  }
  return { command: rewritten, changed: rewritten !== command }
}

/**
 * Moves a subagent's browser calls onto its own throwaway browser. The main
 * thread is left alone: it has no `agent_id`, and its browser is the one the
 * user is watching.
 */
export const browserPreToolUseHook: HookCallback = async (input) => {
  try {
    if (input.hook_event_name !== "PreToolUse") return {}
    if (input.tool_name !== BROWSER_HOOK_TOOL || input.agent_id === undefined) return {}
    if (typeof input.tool_input !== "object" || input.tool_input === null) return {}

    const toolInput = input.tool_input as Record<string, unknown>
    const command = getCommandText(toolInput)

    const redirect = redirectToThrowaway(command, input.agent_id)
    if (redirect === null) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DENIAL,
        },
      }
    }
    if (!redirect.changed) return {}

    const browser = throwawayBrowserName(input.agent_id)
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...toolInput, command: redirect.command },
        additionalContext: `Cogpit redirected this command to the private throwaway browser \`${browser}\`, `
          + "because a subagent must not share the browsers the user can see; report that browser, not `default`.",
      },
    }
  } catch {
    return {}
  }
}
