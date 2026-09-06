import { describe, expect, it } from "vitest"
import { findBrowserInvocations, scanBrowserInvocations } from "../../../shared/browser/invocation"

describe("scanBrowserInvocations", () => {
  it.each([
    '"/path with spaces/agent-browser" open x',
    'agent-\\browser open x',
    'agent-\\\nbrowser open x',
    'AGENT_BROWSER_SESSION=work agent-browser open x',
    'command -- agent-browser open x',
    'exec agent-browser open x',
    'env -i AGENT_BROWSER_SESSION=work agent-browser open x',
    'npx --yes agent-browser open x',
    '2>/dev/null agent-browser open x',
    '(agent-browser open x)',
  ])("finds the executable in %s", (command) => {
    const { invocations, ambiguous } = scanBrowserInvocations(command)
    expect(ambiguous).toBe(false)
    expect(invocations).toHaveLength(1)
    expect(invocations[0].browser).toBe("default")
    expect(command.slice(invocations[0].binaryEnd)).toMatch(/^ open x/)
  })

  it.each([
    ["agent-browser --session 'work' open x", "--session 'work'"],
    ['agent-browser "--session=work" open x', '"--session=work"'],
    ['agent-browser --session wo"rk" open x', '--session wo"rk"'],
    ['agent-browser --session \\\nwork open x', '--session \\\nwork'],
  ])("keeps source offsets for %s", (command, expected) => {
    const [invocation] = findBrowserInvocations(command)
    expect(invocation.browser).toBe("work")
    expect(command.slice(invocation.sessionFlag!.start, invocation.sessionFlag!.end)).toBe(expected)
  })

  it.each([
    'agent-browser open x & agent-browser close',
    'agent-browser open x # agent-browser fake\nagent-browser close',
    'agent-browser eval "agent-browser; --session work"; agent-browser close',
  ])("finds only the two real calls in %s", (command) => {
    expect(scanBrowserInvocations(command)).toMatchObject({ ambiguous: false })
    expect(findBrowserInvocations(command)).toHaveLength(2)
  })

  it.each([
    "agent-browser --session",
    "agent-browser --session '' open x",
    'agent-browser --session="tmp-${NAME}" open x',
    'agent-browser open x$(date)',
    'cat <(agent-browser snapshot)',
    'npx --package some-package agent-browser open x',
    "for url in x; do agent-browser open x; done",
    "BROWSER=agent-browser; $BROWSER open x",
    'sh -c "agent-browser --session tmp-x open x"',
  ])("reports uncertainty for %s", (command) => {
    expect(scanBrowserInvocations(command).ambiguous).toBe(true)
  })
})
