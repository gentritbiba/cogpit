// @vitest-environment node
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import type { HookInput, PreToolUseHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk"
import {
  BROWSER_CONTEXT_APPEND,
  BROWSER_HOOK_TOOL,
  browserPreToolUseHook,
  redirectToThrowaway,
  throwawayBrowserName,
} from "../../browser/agentContext"
import { isValidBrowserName, MAX_BROWSER_NAME_LENGTH } from "../../../shared/browser/names"
import { getCommandText } from "../../../shared/session/toolSummary"

const AGENT = "sub1"
const TMP = "tmp-sub1"

describe("BROWSER_CONTEXT_APPEND", () => {
  it("provides browser ownership rules without requiring a skill read", () => {
    expect(BROWSER_CONTEXT_APPEND).toContain("Browser panel")
    expect(BROWSER_CONTEXT_APPEND).toContain("`default`")
    expect(BROWSER_CONTEXT_APPEND).toContain("--session tmp-")
    expect(BROWSER_CONTEXT_APPEND).toContain("cogpit-browser")
  })

  it("stays short enough to send on every request", () => {
    expect(BROWSER_CONTEXT_APPEND.length).toBeLessThan(1800)
  })

  it("explains shared interaction and when to use it", () => {
    expect(BROWSER_CONTEXT_APPEND).toContain("same tabs and page state")
    expect(BROWSER_CONTEXT_APPEND).toContain("click, type, and navigate")
    expect(BROWSER_CONTEXT_APPEND).toContain("live demos, testing and fixing websites")
    expect(BROWSER_CONTEXT_APPEND).toContain("signed-in accounts")
  })

  it("teaches a manual handoff and the limits of panel awareness", () => {
    expect(BROWSER_CONTEXT_APPEND).toContain("login, 2FA")
    expect(BROWSER_CONTEXT_APPEND).toContain("pause browser actions")
    expect(BROWSER_CONTEXT_APPEND).toContain("Wait for their confirmation, select the handoff tab, take a fresh snapshot")
    expect(BROWSER_CONTEXT_APPEND).toContain("panel and your tool can select different tabs")
    expect(BROWSER_CONTEXT_APPEND).toContain("Leave the `default` browser running unless asked")
    expect(BROWSER_CONTEXT_APPEND).toContain("cannot tell whether the panel is open")
  })
})

describe("redirectToThrowaway", () => {
  it.each([
    ["inserts a session when there is none", "agent-browser open https://x", `agent-browser --session ${TMP} open https://x`],
    ["replaces a named session", "agent-browser --session github open x", `agent-browser --session ${TMP} open x`],
    ["replaces the equals form", "agent-browser --session=default open x", `agent-browser --session ${TMP} open x`],
    ["quotes the executable", `'agent-browser' open x`, `'agent-browser' --session ${TMP} open x`],
    ["joins quoted executable fragments", `agent-'browser' open x`, `agent-'browser' --session ${TMP} open x`],
    ["keeps quoted separators", `agent-browser fill @e1 "a; b && c" --session github`, `agent-browser fill @e1 "a; b && c" --session ${TMP}`],
    ["keeps flag mentions in arguments", `agent-browser eval '"--session work"'`, `agent-browser --session ${TMP} eval '"--session work"'`],
    ["reads quoted flags", `agent-browser '--session' "work" open x`, `agent-browser --session ${TMP} open x`],
    ["handles a pipeline", `agent-browser snapshot | cat`, `agent-browser --session ${TMP} snapshot | cat`],
    ["handles an or-list", `agent-browser open x || agent-browser close`, `agent-browser --session ${TMP} open x || agent-browser --session ${TMP} close`],
    ["keeps redirection targets out of argv", `agent-browser snapshot > agent-browser`, `agent-browser --session ${TMP} snapshot > agent-browser`],
    ["handles environment prefixes", `env AGENT_BROWSER_SESSION=work agent-browser open x`, `env AGENT_BROWSER_SESSION=work agent-browser --session ${TMP} open x`],
    ["handles a package launcher", `bunx agent-browser open x`, `bunx agent-browser --session ${TMP} open x`],
    ["keeps a mention beside a real call", `git commit -m "fix agent-browser" && agent-browser close`, `git commit -m "fix agent-browser" && agent-browser --session ${TMP} close`],
    [
      "rewrites both halves of a chain",
      "agent-browser open x && agent-browser snapshot -i",
      `agent-browser --session ${TMP} open x && agent-browser --session ${TMP} snapshot -i`,
    ],
    [
      "leaves the throwaway half of a mixed chain alone",
      "agent-browser --session tmp-keep open x; agent-browser --session github snapshot",
      `agent-browser --session tmp-keep open x; agent-browser --session ${TMP} snapshot`,
    ],
    [
      "keeps a path-prefixed binary",
      "/usr/local/bin/agent-browser open x",
      `/usr/local/bin/agent-browser --session ${TMP} open x`,
    ],
    [
      "rewrites a newline-separated chain",
      "agent-browser open x\nagent-browser close",
      `agent-browser --session ${TMP} open x\nagent-browser --session ${TMP} close`,
    ],
  ])("%s", (_name, command, expected) => {
    expect(redirectToThrowaway(command, AGENT)).toEqual({ command: expected, changed: true })
  })

  it.each([
    ["a command already on a throwaway", "agent-browser --session tmp-x open y"],
    ["every call of a chain already on one", "agent-browser --session tmp-x open y && agent-browser --session tmp-x close"],
    ["a filename that only looks like the binary", "cat notes/agent-browser-plan.md"],
    ["a command with no browser call at all", "bun run test"],
    ["a commit message", 'git commit -m "fix agent-browser"'],
    ["a single-quoted commit message", "git commit -m 'fix agent-browser'"],
    ["an escaped quote in a commit message", 'git commit -m "fix \\"agent-browser\\" parsing"'],
    ["an unquoted search term", "rg agent-browser server"],
    ["a quoted search pattern containing separators", 'rg "agent-browser.*; agent-browser" server'],
    ["an exact filename", "cat /tmp/agent-browser"],
    ["printed shell code", "printf '%s' '$(agent-browser open x)'"],
    ["a comment", "git status # agent-browser open x"],
    ["a command lookup", "command -v agent-browser"],
    ["a commit after an unrelated interpreter command", 'bun run test && git commit -m "fix agent-browser"'],
    ["a commit before an unrelated interpreter command", 'git commit -m "fix agent-browser"; bun run test'],
  ])("leaves %s untouched", (_name, command) => {
    expect(redirectToThrowaway(command, AGENT)).toEqual({ command, changed: false })
  })

  it("rewrites an argv-array command once it is rendered as text", () => {
    const command = getCommandText({ command: ["agent-browser", "open", "https://x"] })
    expect(redirectToThrowaway(command, AGENT)).toEqual({
      command: `agent-browser --session ${TMP} open https://x`,
      changed: true,
    })
  })

  it.each([
    ["unbalanced quoting", `agent-browser open "https://x`],
    ["the binary inside a quoted string", `sh -c "agent-browser open x"`],
    ["a session name from a variable", "agent-browser --session $BROWSER open x"],
    ["a quoted session name from a variable", `agent-browser --session "$BROWSER" open x`],
    ["a session flag with no readable value", `agent-browser --session="" open x`],
    ["two session flags in one call", "agent-browser --session a --session b open x"],
    ["duplicate flags after a throwaway", "agent-browser --session tmp-x --session default open x"],
    ["a throwaway with an expanded suffix", 'agent-browser --session "tmp-$BROWSER" open x'],
    ["an invalid throwaway name", "agent-browser --session tmp-../x open x"],
    ["command substitution in a quoted message", 'git commit -m "$(agent-browser open x)"'],
    ["substitution after a quoted executable", 'agent-\'browser\' open "$(printf x)"'],
    ["backtick substitution", 'echo `agent-browser open x`'],
    ["eval", "eval 'agent-browser open x'"],
    ["an interpreter", `python -c 'import os; os.system("agent-browser open x")'`],
    ["browser code piped to a shell", "printf 'agent-browser open x' | sh"],
    ["browser code piped across a newline", "printf 'agent-browser open x' |\nsh"],
    ["browser code piped across a comment", "printf 'agent-browser open x' | # note\nsh"],
    ["browser code piped from a subshell", "(printf 'agent-browser open x'; echo) | sh"],
    ["browser code piped to an unfamiliar command", "printf 'agent-browser open x' | ./wrapper"],
    ["an unsupported wrapper", "sudo -u someone agent-browser open x"],
    ["the time keyword", "time agent-browser open x"],
    ["a scheduling wrapper", "nice agent-browser open x"],
    ["a detached wrapper", "nohup agent-browser open x"],
    ["a builtin wrapper", 'builtin eval "agent-browser open x"'],
    ["a custom wrapper", './wrapper "agent-browser open x"'],
    ["a versioned package", "npx agent-browser@latest open x"],
    ["an argument expansion", "agent-browser $FLAGS open x"],
    ["a heredoc", "sh <<'EOF'\nagent-browser open x\nEOF"],
    ["a redirection between flag and value", "agent-browser --session > /dev/null work open x"],
  ])("refuses to guess at %s", (_name, command) => {
    expect(redirectToThrowaway(command, AGENT)).toBeNull()
  })

  it("does not mistake --session-name for the session flag", () => {
    expect(redirectToThrowaway("agent-browser --session-name x open y", AGENT)).toEqual({
      command: `agent-browser --session ${TMP} --session-name x open y`,
      changed: true,
    })
  })

  it("sanitises an agent id into a legal browser name", () => {
    expect(throwawayBrowserName("Agent_1/B!")).toBe("tmp-agent_1-b-")
    expect(redirectToThrowaway("agent-browser open x", "Agent_1/B!")).toEqual({
      command: "agent-browser --session tmp-agent_1-b- open x",
      changed: true,
    })
  })

  it("truncates a long agent id to a name the shim accepts", () => {
    const name = throwawayBrowserName("a".repeat(60))
    expect(name).toHaveLength(MAX_BROWSER_NAME_LENGTH)
    expect(isValidBrowserName(name)).toBe(true)
    expect(redirectToThrowaway("agent-browser open x", "a".repeat(60))?.command)
      .toBe(`agent-browser --session ${name} open x`)
  })

  it.each([
    ['echo "fix agent-browser"', "fix agent-browser\n"],
    ['agent-browser fill @e1 "a; b && c" --session work', '<fill><@e1><a; b && c><--session><tmp-sub1>'],
    [`'agent-browser' --session="work" open 'https://example.com/?a=1&b=2'`, '<--session><tmp-sub1><open><https://example.com/?a=1&b=2>'],
    ['agent-browser snapshot | cat; agent-browser close', '<--session><tmp-sub1><snapshot><--session><tmp-sub1><close>'],
  ])("preserves shell semantics when executing %s", (command, expected) => {
    const redirect = redirectToThrowaway(command, AGENT)
    expect(redirect).not.toBeNull()
    const output = execFileSync("bash", ["--noprofile", "--norc", "-c",
      'agent-browser() { printf "<%s>" "$@"; }\n' + redirect!.command,
    ], { encoding: "utf8" })
    expect(output).toBe(expected)
  })
})

// ── The hook ────────────────────────────────────────────────────────────

function hookInput(overrides: Record<string, unknown> = {}): HookInput {
  return {
    session_id: "s1",
    transcript_path: "/tmp/s1.jsonl",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: BROWSER_HOOK_TOOL,
    tool_use_id: "t1",
    agent_id: AGENT,
    permission_mode: "bypassPermissions",
    tool_input: { command: "agent-browser open https://x" },
    ...overrides,
  } as HookInput
}

async function runHook(input: HookInput): Promise<{ hookSpecificOutput?: PreToolUseHookSpecificOutput }> {
  const result = await browserPreToolUseHook(input, "t1", { signal: new AbortController().signal })
  return result as { hookSpecificOutput?: PreToolUseHookSpecificOutput }
}

describe("browserPreToolUseHook", () => {
  it("never touches the main thread, which has no agent id", async () => {
    expect(await runHook(hookInput({ agent_id: undefined }))).toEqual({})
  })

  it("redirects a subagent's call and says so", async () => {
    const output = (await runHook(hookInput())).hookSpecificOutput
    expect(output?.updatedInput).toEqual({ command: `agent-browser --session ${TMP} open https://x` })
    expect(output?.additionalContext).toContain(TMP)
    expect(output?.additionalContext).toContain("Cogpit redirected")
    expect(output?.permissionDecision).toBeUndefined()
  })

  it("keeps the rest of the tool input", async () => {
    const input = hookInput({ tool_input: { command: "agent-browser open x", timeout: 5000 } })
    expect((await runHook(input)).hookSpecificOutput?.updatedInput)
      .toEqual({ command: `agent-browser --session ${TMP} open x`, timeout: 5000 })
  })

  it.each([
    ["a call already on a throwaway", { tool_input: { command: "agent-browser --session tmp-a open x" } }],
    ["a command that is not browser work", { tool_input: { command: "bun run test" } }],
    ["a filename that only looks like the binary", { tool_input: { command: "cat agent-browser-plan.md" } }],
    ["a commit message mentioning the browser", { tool_input: { command: 'git commit -m "fix agent-browser"' } }],
    ["a search for the binary", { tool_input: { command: "rg agent-browser server" } }],
    ["another tool", { tool_name: "Read", tool_input: { file_path: "/agent-browser" } }],
    ["another event", { hook_event_name: "PostToolUse" }],
    ["a tool input that is not an object", { tool_input: "agent-browser open x" }],
  ])("passes %s through", async (_name, overrides) => {
    expect(await runHook(hookInput(overrides))).toEqual({})
  })

  it("denies a command it cannot rewrite, with a reason the agent can act on", async () => {
    const input = hookInput({ tool_input: { command: "agent-browser --session $BROWSER open x" } })
    const output = (await runHook(input)).hookSpecificOutput
    expect(output?.permissionDecision).toBe("deny")
    expect(output?.permissionDecisionReason).toContain("--session tmp-")
    expect(output?.updatedInput).toBeUndefined()
  })

  it("does not emit a partial rewrite when a later call is ambiguous", async () => {
    const command = `agent-browser open x && sh -c 'agent-browser close'`
    const output = (await runHook(hookInput({ tool_input: { command } }))).hookSpecificOutput
    expect(output?.permissionDecision).toBe("deny")
    expect(output?.updatedInput).toBeUndefined()
  })

  it("swallows a failure rather than breaking the tool call", async () => {
    const toolInput = {}
    Object.defineProperty(toolInput, "command", {
      get() { throw new Error("unreadable input") },
      enumerable: true,
    })
    expect(await runHook(hookInput({ tool_input: toolInput }))).toEqual({})
  })
})
