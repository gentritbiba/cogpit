import { describe, expect, it } from "vitest"
import {
  agentKindFromDirName,
  encodeCodexDirName,
  encodeClaudeDirName,
  findClaudeProjectDirNameForCwd,
  getResumeCommand,
  inferSessionSourceKind,
  isCodexDirName,
  projectDirNameForAgent,
  projectDirNameForNewFolder,
  sessionIdFromFileName,
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
    expect(getResumeCommand("codex", "1234", "/tmp/project dir/it's-here")).toBe(
      "codex -C '/tmp/project dir/it'\\''s-here' resume 1234"
    )
  })

  it("encodes cwd values into codex dir names", () => {
    expect(encodeCodexDirName("/tmp/project")).toMatch(/^codex__/)
    expect(isCodexDirName(encodeCodexDirName("/tmp/project"))).toBe(true)
  })

  it("encodes new folder paths for the selected provider", () => {
    expect(encodeClaudeDirName("/tmp/my-project/")).toBe("-tmp-my-project")
    expect(projectDirNameForNewFolder("/tmp/project", "claude")).toBe("-tmp-project")
    expect(projectDirNameForNewFolder("/tmp/project", "codex")).toBe(encodeCodexDirName("/tmp/project"))
  })

  it("maps a Claude project dir to the selected agent kind", () => {
    expect(projectDirNameForAgent("my-project", "/tmp/project", "claude")).toBe("my-project")
    expect(projectDirNameForAgent("my-project", "/tmp/project", "codex")).toBe(encodeCodexDirName("/tmp/project"))
  })

  it("finds the Claude project dir for a cwd even when the current dir is codex", () => {
    const cwd = "/tmp/project/"
    const projects = [
      { dirName: encodeCodexDirName("/tmp/project"), path: "/tmp/project" },
      { dirName: "tmp-project", path: "/tmp/project" },
    ]

    expect(findClaudeProjectDirNameForCwd(projects, cwd)).toBe("tmp-project")
  })

  describe("sessionIdFromFileName", () => {
    it("strips .jsonl from Claude session file names", () => {
      expect(sessionIdFromFileName("68596e24-db5d-46a4-86fe-9d82425f36d7.jsonl"))
        .toBe("68596e24-db5d-46a4-86fe-9d82425f36d7")
    })

    it("extracts the thread UUID from nested Codex rollout paths", () => {
      expect(sessionIdFromFileName(
        "2026/07/21/rollout-2026-07-21T22-59-57-e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3.jsonl"
      )).toBe("e6ab6cc7-cd47-4056-9c5d-52ff33fdabb3")
    })

    it("extracts the agent UUID from virtual Codex subagent paths", () => {
      expect(sessionIdFromFileName(
        "019f85cf-0ac3-7233-84f9-ac45a79d40e9/subagents/agent-019f8682-1c07-7fe2-8c38-26b0cafe7e08.jsonl"
      )).toBe("019f8682-1c07-7fe2-8c38-26b0cafe7e08")
    })

    it("falls back to stripping .jsonl when no UUID is present", () => {
      expect(sessionIdFromFileName("sess.jsonl")).toBe("sess")
    })
  })
})
