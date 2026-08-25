import { describe, expect, it } from "vitest"
import { getToolSummary } from "../../../shared/session/toolSummary"

function summarize(name: string, input: Record<string, unknown>): string {
  return getToolSummary({ name, input })
}

// Inputs below are trimmed copies of real tool calls in ~/.claude/projects
// transcripts, so the field names are the ones Claude Code actually writes.
describe("getToolSummary — task and agent-mail tools", () => {
  it("SendMessage: leads with the recipient and the sender's own summary", () => {
    expect(summarize("SendMessage", {
      to: "certified-status-fix",
      summary: "Fixed the type error you flagged",
      message: "Good catch — that was mine.",
      type: "message",
      recipient: "certified-status-fix",
      content: "Good catch — that was mine.",
    })).toBe("certified-status-fix · Fixed the type error you flagged")
  })

  it("SendMessage: falls back to the message when no summary was given", () => {
    expect(summarize("SendMessage", { to: "reviewer", message: "Ready for a\nsecond look" }))
      .toBe("reviewer · Ready for a second look")
  })

  it("ListAgents: stays empty — the tool name is the whole story", () => {
    expect(summarize("ListAgents", {})).toBe("")
  })

  it("TaskList: stays empty — the tool name is the whole story", () => {
    expect(summarize("TaskList", {})).toBe("")
  })

  it("TaskCreate: returns the subject", () => {
    expect(summarize("TaskCreate", {
      subject: "Audit SRP + homepage code (4 parallel agents)",
      description: "Four read-only audit agents…",
      activeForm: "Auditing SRP + homepage code",
    })).toBe("Audit SRP + homepage code (4 parallel agents)")
  })

  it("TaskUpdate: points the task id at its new status", () => {
    expect(summarize("TaskUpdate", { taskId: "1", status: "in_progress" })).toBe("1 → in_progress")
  })

  it("TaskUpdate: names the blockers when the update only adds them", () => {
    expect(summarize("TaskUpdate", { taskId: "3", addBlockedBy: ["1", "2"] })).toBe("3 → blocked by 1, 2")
  })

  it("TaskUpdate: falls back to the bare task id", () => {
    expect(summarize("TaskUpdate", { taskId: "3", owner: "reviewer" })).toBe("3")
  })

  it("TaskOutput: returns the task id, ignoring the polling knobs", () => {
    expect(summarize("TaskOutput", { task_id: "a18780353d2535ba0", block: true, timeout: 180000 }))
      .toBe("a18780353d2535ba0")
  })

  it("TaskStop: returns the task id", () => {
    expect(summarize("TaskStop", { task_id: "bxwzjea37" })).toBe("bxwzjea37")
  })
})

describe("getToolSummary — schema-driven payloads", () => {
  it("StructuredOutput: prefers the payload's own summary", () => {
    expect(summarize("StructuredOutput", {
      area: "auth",
      summary: "Two surfaces share one session cookie",
      keyTypes: [],
    })).toBe("Two surfaces share one session cookie")
  })

  it("StructuredOutput: falls back to the verdict when there is no summary", () => {
    expect(summarize("StructuredOutput", {
      refuted: true,
      verdict: "PARTIALLY_TRUE",
      checkedHow: "Re-ran every count with jsdom…",
    })).toBe("PARTIALLY_TRUE")
  })

  it("StructuredOutput: counts the collection when the payload is a list", () => {
    expect(summarize("StructuredOutput", { findings: [{ id: "a" }, { id: "b" }] })).toBe("2 findings")
  })

  it("StructuredOutput: singularises a count of one", () => {
    expect(summarize("StructuredOutput", { verdicts: [{ id: "a" }] })).toBe("1 verdict")
  })

  it("ReportFindings: counts the findings", () => {
    expect(summarize("ReportFindings", { findings: [{}, {}, {}] })).toBe("3 findings")
  })

  it("LSP: keeps the leading string rather than inventing a field name", () => {
    expect(summarize("LSP", { action: "definition", file: "src/a.ts" })).toBe("definition")
  })

  it("Artifact: stays empty when nothing in the payload reads as a gist", () => {
    expect(summarize("Artifact", { version: 3 })).toBe("")
  })
})

describe("getToolSummary — Workflow", () => {
  it("names the workflow from its script meta", () => {
    expect(summarize("Workflow", {
      script: "export const meta = {\n  name: 'honestcms-cross-service-audit',\n  description: 'Map the topology',\n}\n\nconst REPO = '/x'\n",
    })).toBe("honestcms-cross-service-audit")
  })

  it("prefers an explicit description", () => {
    expect(summarize("Workflow", { description: "Audit the payments service", script: "export const meta = { name: 'audit' }" }))
      .toBe("Audit the payments service")
  })

  it("falls back to the script path", () => {
    expect(summarize("Workflow", { scriptPath: "/x/y/review-changes.ts", resumeFromRunId: "run_1" }))
      .toBe("/x/y/review-changes.ts")
  })
})
