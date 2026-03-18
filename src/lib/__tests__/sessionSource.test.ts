import { describe, expect, it } from "vitest"
import {
  agentKindFromDirName,
  encodeCodexDirName,
  getResumeCommand,
  inferSessionSourceKind,
  isCodexDirName,
} from "@/lib/sessionSource"

describe("sessionSource", () => {
  it("detects codex dir names", () => {
    expect(isCodexDirName("codex__L3RtcC9wcm9qZWN0")).toBe(true)
    expect(isCodexDirName("my-project")).toBe(false)
  })

  it("infers the agent kind from dirName", () => {
    expect(inferSessionSourceKind("codex__L3RtcC9wcm9qZWN0")).toBe("codex")
    expect(agentKindFromDirName("my-project")).toBe("claude")
  })

  it("builds the right resume command for each agent", () => {
    expect(getResumeCommand("claude", "1234")).toBe("claude --resume 1234")
    expect(getResumeCommand("codex", "1234")).toBe("codex resume 1234")
  })

  it("encodes cwd values into codex dir names", () => {
    expect(encodeCodexDirName("/tmp/project")).toMatch(/^codex__/)
    expect(isCodexDirName(encodeCodexDirName("/tmp/project"))).toBe(true)
  })
})
