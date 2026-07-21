// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/projects" },
  isWithinDir: vi.fn(() => true),
  readdir: vi.fn(),
  readFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

import { isWithinDir, readdir, readFile } from "../../helpers"
import {
  summarizeJournal,
  normalizeDetail,
  isTerminalAgentState,
  listSessionWorkflows,
  readWorkflowDetail,
  workflowsDirFor,
  type WorkflowJournal,
} from "../../lib/workflows"

const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedIsWithinDir = vi.mocked(isWithinDir)

function journal(overrides: Partial<WorkflowJournal> = {}): WorkflowJournal {
  return {
    runId: "wf_abc-123",
    workflowName: "review-prs",
    summary: "Review the PRs",
    status: "running",
    startTime: 1000,
    agentCount: 3,
    totalTokens: 500,
    totalToolCalls: 12,
    phases: [{ title: "Map" }, { title: "Review", detail: "per dimension" }],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Map" },
      { type: "workflow_agent", index: 1, label: "map:pr1", phaseIndex: 1, phaseTitle: "Map", agentId: "a1", state: "done", tokens: 100, toolCalls: 4 },
      { type: "workflow_agent", index: 2, label: "rev:pr1", phaseIndex: 2, phaseTitle: "Review", agentId: "a2", state: "running", lastToolName: "Read" },
      { type: "workflow_agent", index: 3, label: "rev:pr2", phaseIndex: 2, phaseTitle: "Review", agentId: "a3", state: "error" },
    ],
    ...overrides,
  }
}

describe("workflow normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedIsWithinDir.mockReturnValue(true)
  })

  describe("isTerminalAgentState", () => {
    it("treats done/error/skipped as terminal and others as not", () => {
      expect(isTerminalAgentState("done")).toBe(true)
      expect(isTerminalAgentState("error")).toBe(true)
      expect(isTerminalAgentState("skipped")).toBe(true)
      expect(isTerminalAgentState("running")).toBe(false)
      expect(isTerminalAgentState("queued")).toBe(false)
      expect(isTerminalAgentState("progress")).toBe(false)
    })
  })

  describe("summarizeJournal", () => {
    it("computes agent counts by state", () => {
      const s = summarizeJournal("wf_abc-123", journal())
      expect(s.agentCounts).toEqual({ total: 3, queued: 0, running: 1, done: 1, error: 1 })
    })

    it("treats unknown non-terminal states as running", () => {
      const s = summarizeJournal("wf_x", journal({
        workflowProgress: [
          { type: "workflow_agent", index: 1, label: "a", phaseIndex: 1, phaseTitle: "P", agentId: "a1", state: "progress" },
        ],
      }))
      expect(s.agentCounts.running).toBe(1)
      expect(s.agentCounts.total).toBe(1)
    })

    it("carries phase titles and core metadata", () => {
      const s = summarizeJournal("wf_abc-123", journal())
      expect(s.phaseCount).toBe(2)
      expect(s.phaseTitles).toEqual(["Map", "Review"])
      expect(s.workflowName).toBe("review-prs")
      expect(s.status).toBe("running")
      expect(s.totalTokens).toBe(500)
    })

    it("falls back to runId and defaults on a sparse journal", () => {
      const s = summarizeJournal("wf_fallback", {})
      expect(s.runId).toBe("wf_fallback")
      expect(s.workflowName).toBe("wf_fallback")
      expect(s.status).toBe("running")
      expect(s.agentCount).toBe(0)
      expect(s.phaseCount).toBe(0)
    })
  })

  describe("normalizeDetail", () => {
    it("includes only workflow_agent entries as agents, plus phases and script", () => {
      const d = normalizeDetail("wf_abc-123", journal({ script: "export const meta = {}", defaultModel: "claude-opus-4-8[1m]" }))
      expect(d.agents).toHaveLength(3)
      expect(d.agents.every((a) => a.type === "workflow_agent")).toBe(true)
      expect(d.phases).toHaveLength(2)
      expect(d.script).toContain("meta")
      expect(d.defaultModel).toBe("claude-opus-4-8[1m]")
    })

    it("truncates a large result into resultPreview", () => {
      const big = { data: "x".repeat(8000) }
      const d = normalizeDetail("wf_abc-123", journal({ result: big }))
      expect(d.resultPreview).toBeDefined()
      expect(d.resultPreview!.length).toBeLessThanOrEqual(4001)
      expect(d.resultPreview!.endsWith("…")).toBe(true)
    })

    it("omits resultPreview when result is null", () => {
      const d = normalizeDetail("wf_abc-123", journal({ result: null }))
      expect(d.resultPreview).toBeUndefined()
    })
  })

  describe("workflowsDirFor", () => {
    it("returns null when the resolved path escapes PROJECTS_DIR", () => {
      mockedIsWithinDir.mockReturnValueOnce(false)
      expect(workflowsDirFor("../evil", "sess")).toBeNull()
    })

    it("builds the workflows path under the session dir", () => {
      expect(workflowsDirFor("proj", "sess")).toBe("/projects/proj/sess/workflows")
    })
  })

  describe("listSessionWorkflows", () => {
    it("returns [] when the workflows dir is missing", async () => {
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))
      expect(await listSessionWorkflows("proj", "sess")).toEqual([])
    })

    it("parses wf_*.json files and sorts newest first, skipping junk", async () => {
      mockedReaddir.mockResolvedValueOnce(["wf_old.json", "wf_new.json", "notes.txt", "scripts"] as never)
      mockedReadFile.mockImplementation(async (path: Parameters<typeof readFile>[0]) => {
        const p = String(path)
        if (p.includes("wf_old.json")) return JSON.stringify(journal({ runId: "wf_old", startTime: 100 }))
        if (p.includes("wf_new.json")) return JSON.stringify(journal({ runId: "wf_new", startTime: 999 }))
        throw new Error("unexpected read " + p)
      })
      const list = await listSessionWorkflows("proj", "sess")
      expect(list.map((w) => w.runId)).toEqual(["wf_new", "wf_old"])
    })

    it("skips files that fail to parse", async () => {
      mockedReaddir.mockResolvedValueOnce(["wf_bad.json", "wf_ok.json"] as never)
      mockedReadFile.mockImplementation(async (path: Parameters<typeof readFile>[0]) => {
        const p = String(path)
        if (p.includes("wf_bad.json")) return "{not json"
        return JSON.stringify(journal({ runId: "wf_ok", startTime: 5 }))
      })
      const list = await listSessionWorkflows("proj", "sess")
      expect(list.map((w) => w.runId)).toEqual(["wf_ok"])
    })
  })

  describe("readWorkflowDetail", () => {
    it("rejects runIds that are not wf_*.json", async () => {
      expect(await readWorkflowDetail("proj", "sess", "../escape")).toBeNull()
      expect(mockedReadFile).not.toHaveBeenCalled()
    })

    it("rejects path-traversal runIds even when wf_-prefixed (no file read)", async () => {
      // isWithinDir is mocked to true, so this proves isSafeRunId blocks it.
      expect(await readWorkflowDetail("proj", "sess", "wf_../../../../etc/hosts")).toBeNull()
      expect(await readWorkflowDetail("proj", "sess", "wf_a/b")).toBeNull()
      expect(await readWorkflowDetail("proj", "sess", "wf_..")).toBeNull()
      expect(mockedReadFile).not.toHaveBeenCalled()
    })

    it("returns null when the journal is missing", async () => {
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))
      expect(await readWorkflowDetail("proj", "sess", "wf_missing")).toBeNull()
    })

    it("returns a normalized detail for a valid journal", async () => {
      mockedReadFile.mockResolvedValueOnce(JSON.stringify(journal({ runId: "wf_abc-123" })))
      const d = await readWorkflowDetail("proj", "sess", "wf_abc-123")
      expect(d).not.toBeNull()
      expect(d!.runId).toBe("wf_abc-123")
      expect(d!.agents).toHaveLength(3)
    })
  })
})
