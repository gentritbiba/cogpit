// @vitest-environment node
import { describe, expect, it } from "vitest"
import { COGPIT_SKILL_FILES } from "../../agents/bundledSkills"

const browser = COGPIT_SKILL_FILES["references/browser.md"]
const browserGuide = browser + COGPIT_SKILL_FILES["references/browser-advanced.md"]

describe("the browser guide", () => {
  it("teaches request reuse and a fresh human handoff when clearance expires", () => {
    expect(browserGuide).toContain("/api/browser/sessions/default/request")
    expect(browserGuide).toContain("state: challenge-required")
    expect(browserGuide).toContain("Wait for their confirmation before retrying")
    expect(browserGuide).toContain("Subagents must not use this")
    expect(browserGuide).toContain("Never export clearance cookies")
  })

  it("makes the throwaway rule for subagents explicit", () => {
    expect(browserGuide).toContain("--session tmp-")
    expect(browser).toContain("If you are a subagent, use `--session tmp-<unique>`")
    expect(browserGuide).toMatch(/Never touch `default` or a named browser from a subagent/)
    expect(browserGuide).toContain("close")
  })

  it("explains redirection and the limits of hook coverage", () => {
    expect(browser).toContain("Recognized SDK subagent")
    expect(browser).toContain("outside hook coverage")
    expect(browser).toContain("calls are redirected")
  })

  it("lists the flags Cogpit owns", () => {
    for (const flag of ["--profile", "--state", "--session-name", "--args", "--headed", "--cdp"]) {
      expect(browserGuide).toContain(flag)
    }
  })

  it("resolves the server port the way the sessions guide does", () => {
    expect(browserGuide).toContain('PORT="${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}"')
    expect(browserGuide).toContain('curl -s "$BASE/api/browser"')
    expect(browserGuide).toContain("PATCH")
  })

  it("warns that the panel drives the page viewport", () => {
    expect(browser).toContain("The Browser panel can change the viewport")
    expect(browserGuide).toContain("agent-browser set viewport <w> <h>")
  })

  it("keeps browsers headless and reserves a window for a bot check the user must pass", () => {
    expect(browserGuide).toMatch(/## Headless by default/)
    expect(browserGuide).toContain("COGPIT_BROWSER_HEADED=1 agent-browser --session <name> open <url>")
    expect(browserGuide).toContain("Verify you are human")
    expect(browserGuide).toMatch(/close that browser so the next task starts\s+headless/)
    expect(browserGuide).toMatch(/only honoured on the call that launches the browser/)
  })

  it("shows how to mark up a screenshot and clean the overlay up afterwards", () => {
    expect(browserGuide).toMatch(/## Marking up screenshots/)
    expect(browserGuide).toContain("agent-browser eval --stdin")
    expect(browserGuide).toContain("window.__markup?.svg.remove()")
  })

  it("tells the agent to name the browser and to hand logins to the user", () => {
    expect(browserGuide).toContain("open the Browser panel to watch")
    expect(browserGuide).toMatch(/log in inside the Browser panel/)
  })
})
