import { describe, expect, it } from "vitest"
import { getCommandText, getToolPresentation, getToolSummary, getToolTier } from "../../../shared/session/toolSummary"

function summarize(name: string, input: Record<string, unknown>): string {
  return getToolSummary({ name, input })
}

describe("consistent tool presentation", () => {
  it.each([
    ["Bash", "functions.exec_command", { cmd: "bun run test" }, "Run command", "Bash"],
    ["Task", "collaboration.spawn_agent", { description: "Check rendering", task_name: "Check rendering" }, "Spawn agent", "Task"],
    ["AskUserQuestion", "functions.request_user_input_async", { questions: [{ question: "Which theme?", title: "Which theme?" }] }, "Ask question", "AskUserQuestion"],
    ["ToolSearch", "functions.tool_search", { query: "search docs" }, "Find tools", "ToolSearch"],
  ])("presents %s and %s as the same operation", (claudeName, codexName, input, label, styleName) => {
    const claude = getToolPresentation({ name: claudeName, input })
    expect(claude).toMatchObject({ label, styleName })
    expect(getToolPresentation({ name: codexName, input })).toEqual(claude)
  })

  it("counts both Claude todos and Codex plan steps", () => {
    expect(getToolPresentation({ name: "TodoWrite", input: { todos: [{ content: "Inspect" }, { content: "Fix" }] } }))
      .toEqual(getToolPresentation({ name: "functions.update_plan", input: { plan: [{ step: "Inspect" }, { step: "Fix" }] } }))
    expect(summarize("TodoWrite", { todos: [{ content: "Inspect" }] })).toBe("1 step")
  })

  it("keeps unknown tool summaries readable and excludes raw orchestration", () => {
    expect(getToolPresentation({ name: "custom_lookup", input: { limit: 10, query: "find\n the\tfile" } }))
      .toMatchObject({ label: "Custom lookup", summary: "find the file" })
    expect(summarize("custom_lookup", { raw: "const internal = 1" })).toBe("")
    expect(summarize("Read", { path: "x".repeat(500) })).toHaveLength(140)
    expect(() => summarize("AskUserQuestion", { questions: [null, 5, {}] })).not.toThrow()
  })

  it("uses the same style for native aliases and keeps read-only operations quiet", () => {
    expect(getToolTier("functions.exec_command")).toBe(getToolTier("Bash"))
    expect(getToolTier("functions.apply_patch")).toBe(getToolTier("Edit"))
    expect(getToolTier("collaboration.list_agents")).toBe("readOnly")
    expect(getToolTier("collaboration.wait_agent")).toBe("readOnly")
    expect(getToolTier("functions.get_goal")).toBe("readOnly")
    expect(getToolTier("mcp__server__exec_command")).toBe("readOnly")
  })

  it("presents direct and wrapped web requests consistently", () => {
    const input = { search_query: [{ q: "rendering tools" }] }
    expect(getToolPresentation({ name: "web__run", input })).toEqual(
      getToolPresentation({ name: "exec", input: { raw: `text(await tools.web__run(${JSON.stringify(input)}))` } }),
    )
  })

  it("does not display encrypted agent message content in summaries", () => {
    const message = "gAAAAABencrypted_payload_123=="
    expect(summarize("send_message", { target: "reviewer", message })).toBe("reviewer · Encrypted message")
    expect(summarize("spawn_agent", { message })).toBe("Encrypted message")
    expect(summarize("SendMessage", { to: "reviewer", message })).toBe("reviewer · Encrypted message")
    expect(summarize("exec", { raw: `tools.send_message({ target: "reviewer", message: "${message}" })` }))
      .toBe("reviewer · Encrypted message")
  })
})

describe("command display", () => {
  it("preserves string commands and argv boundaries", () => {
    expect(getCommandText({ cmd: "bun run test && bun run lint" })).toBe("bun run test && bun run lint")
    expect(getCommandText({ command: ["git", "show", "HEAD:src/a b.ts"] })).toBe("git show 'HEAD:src/a b.ts'")
    expect(getCommandText({ command: ["echo", "", "it's", "$(whoami)"] })).toBe(`echo '' 'it'"'"'s' '$(whoami)'`)
    expect(getCommandText({ command: ["git", 5] })).toBe("")
    expect(summarize("Bash", { command: ["git", "show", "HEAD:src/a b.ts"] })).toBe("git show 'HEAD:src/a b.ts'")
  })
})

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
