import { describe, expect, it } from "vitest"

import {
  AGENT_KINDS,
  DEFAULT_AGENT_KIND,
  agentKindForDirName,
  allDescriptors,
  capabilitiesFor,
  capabilitiesForDirName,
  descriptorFor,
  fileNameFromUrlId,
  findProjectDirNameForCwd,
  getResumeCommand,
  getResumeSpawn,
  parseAgentKind,
  projectDirNameFor,
  sessionIdFromFileName,
  sessionUrlIdFromFileName,
} from "@/lib/agents"
import {
  AGENT_OPTIONS,
  agentConfigBadge,
  agentIcon,
  agentInterruptLabel,
  agentProjectBadge,
  readOnlySessionNotice,
} from "@/lib/agents/presentation"

const CODEX_DIR = "codex__L3RtcC9wcm9qZWN0"
const COPILOT_DIR = "copilot__L3RtcC9wcm9qZWN0"
const CLAUDE_DIR = "-tmp-project"
const SESSION_UUID = "68596e24-db5d-46a4-86fe-9d82425f36d7"

describe("agent registry", () => {
  it("resolves the owning agent from a project directory", () => {
    expect(agentKindForDirName(CLAUDE_DIR)).toBe("claude")
    expect(agentKindForDirName(CODEX_DIR)).toBe("codex")
    expect(agentKindForDirName(COPILOT_DIR)).toBe("copilot")
  })

  it("falls back to the terminal agent for an unknown directory", () => {
    expect(agentKindForDirName(null)).toBe(DEFAULT_AGENT_KIND)
    expect(agentKindForDirName(undefined)).toBe(DEFAULT_AGENT_KIND)
  })

  it("round-trips a project path through every agent's directory encoding", () => {
    for (const kind of AGENT_KINDS) {
      const dirName = projectDirNameFor(kind, "/tmp/project")
      expect(agentKindForDirName(dirName)).toBe(kind)
    }
    // Claude's encoding is lossy, so a known directory name wins over re-deriving it.
    expect(projectDirNameFor("claude", "/tmp/project", "known-dir")).toBe("known-dir")
    expect(projectDirNameFor("codex", "/tmp/project", "known-dir")).toBe(CODEX_DIR)
  })

  it("narrows an arbitrary server string to an agent kind", () => {
    expect(parseAgentKind("codex", "claude")).toBe("codex")
    expect(parseAgentKind("gemini", "claude")).toBe("claude")
    expect(parseAgentKind(undefined, "claude")).toBe("claude")
  })

  it("finds the project directory a given agent uses for a path", () => {
    const projects = [
      { dirName: CLAUDE_DIR, path: "/tmp/project/" },
      { dirName: CODEX_DIR, path: "/tmp/project" },
      { dirName: COPILOT_DIR, path: "/tmp/project" },
    ]
    expect(findProjectDirNameForCwd(projects, "/tmp/project", "claude")).toBe(CLAUDE_DIR)
    expect(findProjectDirNameForCwd(projects, "/tmp/project", "codex")).toBe(CODEX_DIR)
    expect(findProjectDirNameForCwd(projects, "/elsewhere", "claude")).toBeNull()
  })
})

describe("session file and URL codecs", () => {
  it("recovers a session id from any agent's transcript name", () => {
    expect(sessionIdFromFileName(`${SESSION_UUID}.jsonl`)).toBe(SESSION_UUID)
    expect(sessionIdFromFileName(`${SESSION_UUID}/events.jsonl`)).toBe(SESSION_UUID)
    expect(sessionIdFromFileName(
      `2026/08/01/rollout-2026-08-01T10-00-00-${SESSION_UUID}.jsonl`,
    )).toBe(SESSION_UUID)
    expect(sessionIdFromFileName("sess.jsonl")).toBe("sess")
  })

  it("keeps the URL id and the on-disk name exact inverses", () => {
    const cases: Array<[string, string]> = [
      [CLAUDE_DIR, `${SESSION_UUID}.jsonl`],
      [COPILOT_DIR, `${SESSION_UUID}/events.jsonl`],
      [CODEX_DIR, `2026/08/01/rollout-2026-08-01T10-00-00-${SESSION_UUID}.jsonl`],
      [CLAUDE_DIR, `${SESSION_UUID}/subagents/agent-abc.jsonl`],
    ]
    for (const [dirName, fileName] of cases) {
      const urlId = sessionUrlIdFromFileName(dirName, fileName)
      expect(fileNameFromUrlId(dirName, urlId)).toBe(fileName)
    }
  })

  it("shortens a Copilot URL to the bare session id", () => {
    expect(sessionUrlIdFromFileName(COPILOT_DIR, `${SESSION_UUID}/events.jsonl`))
      .toBe(SESSION_UUID)
  })
})

describe("resume", () => {
  it("spawns each agent's own binary", () => {
    expect(getResumeSpawn("claude", "sess")).toEqual({
      command: "claude",
      args: ["--resume", "sess"],
    })
    expect(getResumeSpawn("codex", "sess")).toEqual({
      command: "codex",
      args: ["resume", "sess"],
    })
    expect(getResumeSpawn("copilot", "sess")).toEqual({
      command: "copilot",
      args: ["--resume=sess"],
    })
  })

  it("produces a copy-pasteable command that names the same binary", () => {
    expect(getResumeCommand("claude", "1234")).toBe("claude --resume 1234")
    expect(getResumeCommand("codex", "1234")).toBe("codex resume 1234")
    expect(getResumeCommand("codex", "1234", "/tmp/project dir/it's-here")).toBe(
      "codex -C '/tmp/project dir/it'\\''s-here' resume 1234",
    )
    expect(getResumeCommand("copilot", "1234", "/tmp/project dir/it's-here")).toBe(
      "copilot -C '/tmp/project dir/it'\\''s-here' --resume 1234",
    )
    for (const kind of AGENT_KINDS) {
      expect(getResumeCommand(kind, "1234").startsWith(descriptorFor(kind).binName)).toBe(true)
    }
  })
})

describe("capabilities", () => {
  it("reads the same flags whether resolved by kind or by directory", () => {
    expect(capabilitiesForDirName(CODEX_DIR)).toBe(capabilitiesFor("codex"))
    expect(capabilitiesForDirName(null)).toBe(capabilitiesFor(DEFAULT_AGENT_KIND))
  })

  it("keeps ultracode independent of worktrees, which used to gate it", () => {
    for (const { capabilities } of allDescriptors()) {
      if (capabilities.ultracode) expect(capabilities.reasoningEffort).toBe(true)
    }
    expect(capabilitiesFor("claude").ultracode).toBe(true)
    expect(capabilitiesFor("codex").ultracode).toBe(false)
    expect(capabilitiesFor("copilot").ultracode).toBe(false)
  })

  it("only nests sub-agents where they own a session id", () => {
    // Usage cost walks the child tree transitively when this is set. Claude
    // repeats the root session id in every descendant, so listing the root's
    // children already yields all of them; a walk there would loop.
    expect(capabilitiesFor("codex").nestedSubagents).toBe(true)
    expect(capabilitiesFor("claude").nestedSubagents).toBe(false)
    expect(capabilitiesFor("copilot").nestedSubagents).toBe(false)
    for (const { capabilities } of allDescriptors()) {
      if (capabilities.nestedSubagents) expect(capabilities.subagentTranscripts).toBe(true)
    }
  })
})

describe("presentation", () => {
  it("covers every agent the registry knows about", () => {
    // Every agent is offered, but in display order — the default agent leads,
    // where registry order is transcript-detection order and would bury it last.
    expect([...AGENT_OPTIONS.map((option) => option.value)].sort())
      .toEqual([...AGENT_KINDS].sort())
    expect(AGENT_OPTIONS[0].value).toBe("claude")
    for (const kind of AGENT_KINDS) {
      expect(agentIcon(kind)).toBeTruthy()
      expect(agentInterruptLabel(kind)).toBeTruthy()
      // The config badge used to omit Copilot entirely.
      expect(agentConfigBadge(kind).letter).toHaveLength(1)
      expect(agentConfigBadge(kind).label).toContain("Loaded by")
      expect(readOnlySessionNotice(kind)).toContain("Cogpit can only view it")
    }
  })

  it("leaves the default agent's project rows unbadged", () => {
    expect(agentProjectBadge(DEFAULT_AGENT_KIND)).toBeNull()
    expect(agentProjectBadge("codex")).toBe("Codex")
    expect(agentProjectBadge("copilot")).toBe("Copilot")
  })

  it("gives every agent a distinct config-badge letter", () => {
    const letters = AGENT_KINDS.map((kind) => agentConfigBadge(kind).letter)
    expect(new Set(letters).size).toBe(letters.length)
  })
})
