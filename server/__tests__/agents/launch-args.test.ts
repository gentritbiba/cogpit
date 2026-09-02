// @vitest-environment node
import { describe, expect, it } from "vitest"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"

/**
 * The argv each descriptor hands its CLI. These strings reach a real process,
 * so they are pinned exactly rather than asserted loosely — a silent change to
 * a sandbox flag is a silent change to what an agent is allowed to do.
 */
describe("AgentDescriptor.launchArgs", () => {
  const claude = descriptorFor("claude").launchArgs
  const codex = descriptorFor("codex").launchArgs
  const copilot = descriptorFor("copilot").launchArgs

  it("returns nothing for a setting that was not chosen", () => {
    for (const kind of AGENT_KINDS) {
      const launchArgs = descriptorFor(kind).launchArgs
      expect(launchArgs.model()).toEqual([])
      expect(launchArgs.effort()).toEqual([])
      expect(launchArgs.fastTier()).toEqual([])
      expect(launchArgs.fastTier(false)).toEqual([])
    }
  })

  // ── missing-mode footgun (security) ────────────────────────────────────
  // A missing or falsy mode must NEVER widen access. It fails safe: Claude
  // falls back to its default mode and Codex stays sandboxed.

  it("never reads a missing mode as a bypass", () => {
    expect(claude.permissions()).toEqual(["--permission-mode", "default"])
    expect(claude.permissions({})).toEqual(["--permission-mode", "default"])
    expect(claude.permissions({ mode: "" })).toEqual(["--permission-mode", "default"])

    const sandboxed = ["--sandbox", "workspace-write", "-c", 'approval_policy="never"']
    expect(codex.permissions()).toEqual(sandboxed)
    expect(codex.permissions({ mode: "" })).toEqual(sandboxed)

    expect(copilot.permissions()).toEqual([])
    expect(copilot.permissions({ mode: "" })).toEqual([])
  })

  it("builds Claude's permission flags", () => {
    expect(claude.permissions({ mode: "bypassPermissions" }))
      .toEqual(["--dangerously-skip-permissions"])
    expect(claude.permissions({ mode: "default" })).toEqual(["--permission-mode", "default"])
    expect(claude.permissions({ mode: "plan" })).toEqual(["--permission-mode", "plan"])
    expect(claude.permissions({
      mode: "plan",
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["Write"],
    })).toEqual([
      "--permission-mode", "plan",
      "--allowedTools", "Bash",
      "--allowedTools", "Read",
      "--disallowedTools", "Write",
    ])
  })

  it("drops a mode the Claude CLI does not accept, keeping the tools", () => {
    expect(claude.permissions({ mode: "delegate", allowedTools: ["Bash"] }))
      .toEqual(["--allowedTools", "Bash"])
  })

  it("keeps `codex exec` sandboxed, since it cannot prompt for approval", () => {
    expect(codex.permissions({ mode: "plan" }))
      .toEqual(["--sandbox", "read-only", "-c", 'approval_policy="never"'])
    expect(codex.permissions({ mode: "acceptEdits" }))
      .toEqual(["--sandbox", "workspace-write", "-c", 'approval_policy="never"'])
    expect(codex.permissions({ mode: "bypassPermissions" }))
      .toEqual(["--dangerously-bypass-approvals-and-sandbox"])
  })

  it("gives Copilot full access only for an explicitly unattended mode", () => {
    expect(copilot.permissions({ mode: "bypassPermissions" })).toEqual(["--allow-all"])
    expect(copilot.permissions({ mode: "auto" })).toEqual(["--allow-all"])
    expect(copilot.permissions({ mode: "plan" })).toEqual([])
  })

  it("builds each CLI's model and effort flags", () => {
    expect(claude.model("opus")).toEqual(["--model", "opus"])
    expect(claude.effort("high")).toEqual(["--effort", "high"])
    expect(codex.model("gpt-5.6")).toEqual(["-m", "gpt-5.6"])
    expect(codex.effort("high")).toEqual(["-c", 'model_reasoning_effort="high"'])
    expect(copilot.model("claude-opus-4-6")).toEqual(["--model", "claude-opus-4-6"])
    expect(copilot.effort("high")).toEqual(["--reasoning-effort", "high"])
  })
})

/**
 * Codex is driven over two transports that were given different wire values for
 * the same fast-mode request. Both are pinned here so neither drifts before
 * someone can verify which the CLI honours and collapse them into one.
 */
describe("AgentDescriptor.serviceTier", () => {
  it("records both Codex spellings of a fast-mode request", () => {
    expect(descriptorFor("codex").serviceTier).toEqual({
      appServerValue: "priority",
      cliConfigValue: "fast",
    })
  })

  it("spends the CLI spelling on the spawned `codex exec` path", () => {
    expect(descriptorFor("codex").launchArgs.fastTier(true))
      .toEqual(["-c", 'service_tier="fast"', "--enable", "fast_mode"])
  })

  it("has no tier for the agents that request speed some other way", () => {
    expect(descriptorFor("claude").serviceTier).toBeNull()
    expect(descriptorFor("copilot").serviceTier).toBeNull()
  })
})
