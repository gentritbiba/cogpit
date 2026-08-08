import { describe, expect, it } from "vitest"
import {
  countJsCollectionEntries,
  extractCodexExecInvocations,
  extractJsPropertySource,
  extractJsStringPropertyValues,
} from "../../../shared/session/codex-exec"
import { getToolPresentation } from "../../../shared/session/toolSummary"

function execPresentation(raw: string) {
  return getToolPresentation({ name: "exec", input: { raw } })
}

describe("Codex exec source extraction", () => {
  it("finds dot and bracket tool calls while ignoring strings and comments", () => {
    const source = String.raw`
      const example = "tools.fake({ value: ')' })";
      // tools.commented_out({ nope: true });
      const first = await tools.web__run({ search_query: [{ q: "codex (tool calls)" }] });
      const second = await tools["view_image"]({ path: "/tmp/screenshot.png" });
    `

    expect(extractCodexExecInvocations(source).map((call) => call.name)).toEqual([
      "web__run",
      "view_image",
    ])
  })

  it("resolves a simple assigned object argument", () => {
    const source = `
      const request = { search_query: [{ q: "assigned query" }] };
      const result = await tools.web__run(request);
      text(result);
    `

    const [call] = extractCodexExecInvocations(source)
    expect(call.argumentSource).toContain("search_query")
    expect(execPresentation(source)).toMatchObject({
      label: "Search web",
      summary: "assigned query",
    })
  })

  it("reads quoted and unquoted object properties without evaluating code", () => {
    const source = `{ "search_query": [{ "q": "quoted" }], open: [{ ref_id: "turn1view0" }] }`
    expect(extractJsPropertySource(source, "search_query")).toContain("quoted")
    expect(extractJsStringPropertyValues(source, "q")).toEqual(["quoted"])
    expect(countJsCollectionEntries('[{ q: "a" }, { q: "b" }]')).toBe(2)
  })
})

describe("Codex exec tool presentation", () => {
  it.each([
    [
      'await tools.web__run({ search_query: [{ q: "site:developers.openai.com app server" }] })',
      "Search web",
      "site:developers.openai.com app server",
    ],
    [
      'await tools.web__run({ image_query: [{ q: "Saturn rings" }] })',
      "Search images",
      "Saturn rings",
    ],
    [
      'await tools.web__run({ open: [{ ref_id: "turn1view0", lineno: 830 }] })',
      "Open page",
      "turn1view0 · line 830",
    ],
    [
      'await tools.web__run({ click: [{ ref_id: "turn4view2", id: 415 }] })',
      "Open link",
      "turn4view2 · link 415",
    ],
    [
      'await tools.web__run({ find: [{ ref_id: "turn3view0", pattern: "commandExecution" }] })',
      "Find on page",
      "commandExecution · turn3view0",
    ],
    [
      'await tools.web__run({ screenshot: [{ ref_id: "turn1view0", pageno: 3 }] })',
      "Capture page",
      "turn1view0 · page 4",
    ],
    [
      'await tools.web__run({ finance: [{ ticker: "AMD", type: "equity", market: "USA" }] })',
      "Check markets",
      "AMD",
    ],
    [
      'await tools.web__run({ weather: [{ location: "Belgrade, Serbia" }] })',
      "Check weather",
      "Belgrade, Serbia",
    ],
    [
      'await tools.web__run({ sports: [{ fn: "schedule", league: "nba", team: "GSW" }] })',
      "Check sports",
      "nba · +1 more",
    ],
    [
      'await tools.web__run({ time: [{ utc_offset: "+02:00" }] })',
      "Check time",
      "+02:00",
    ],
  ])("identifies a web operation: %s", (raw, label, summary) => {
    expect(execPresentation(raw)).toMatchObject({ label, summary, styleName: "WebSearch" })
  })

  it("summarizes every operation in a combined web request", () => {
    const presentation = execPresentation(`
      const result = await tools.web__run({
        search_query: [{ q: "one" }, { q: "two" }],
        open: [{ ref_id: "turn1search0" }],
        find: [{ ref_id: "turn1view0", pattern: "schema" }],
      });
      text(result);
    `)

    expect(presentation).toEqual({
      label: "Browse web",
      summary: "2 searches · 1 page · 1 find",
      styleName: "WebSearch",
    })
  })

  it.each([
    ['await tools.exec_command({ cmd: "bun run test", workdir: "/workspace" })', "Run command", "bun run test", "Bash"],
    ['await tools.write_stdin({ session_id: 42, chars: "q" })', "Continue command", "session 42 · q", "Bash"],
    ['await tools.view_image({ path: "/tmp/screenshot.png" })', "View image", "/tmp/screenshot.png", "Read"],
    ['await tools.update_plan({ plan: [{ step: "Inspect" }, { step: "Fix" }] })', "Update plan", "2 steps", "TodoWrite"],
    ['await tools.create_goal({ objective: "Ship the feature" })', "Create goal", "Ship the feature", "TodoWrite"],
    ['await tools.update_goal({ status: "complete" })', "Update goal", "complete", "TodoWrite"],
    ['await tools.list_mcp_resources({ server: "docs" })', "List MCP resources", "docs", "Mcp"],
    ['await tools.read_mcp_resource({ server: "docs", uri: "docs://tool-calls" })', "Read MCP resource", "docs · docs://tool-calls", "Mcp"],
    ['await tools.request_plugin_install({ plugin_id: "github@openai-curated-remote" })', "Install plugin", "github@openai-curated-remote", "Mcp"],
    ['await tools.image_gen__imagegen({ prompt: "A copper robot" })', "Generate image", "A copper robot", "Image"],
  ])("identifies a nested tool: %s", (raw, label, summary, styleName) => {
    expect(execPresentation(raw)).toEqual({ label, summary, styleName })
  })

  it("uses the MCP server as the label and the action as the summary", () => {
    expect(execPresentation(
      'const r = await tools.mcp__figma__get_screenshot({ nodeId: "12:34" }); image(r);',
    )).toEqual({
      label: "Figma",
      summary: "Get screenshot",
      styleName: "Mcp",
    })
  })

  it("keeps the label groupable and counts repeats in the summary", () => {
    const presentation = execPresentation(`
      await tools.exec_command({ cmd: "bun run lint" });
      await tools.exec_command({ cmd: "bun run test" });
    `)

    // Callers group by label and append their own ×count, so the label itself
    // must not carry one — otherwise the row reads "Run command ×2 ×3".
    expect(presentation.label).toBe("Run command")
    expect(presentation.summary).toBe("×2 · bun run lint · +1 more")
  })

  it("summarizes multiple different calls instead of leaking orchestration code", () => {
    const presentation = execPresentation(`
      const [test, image] = await Promise.all([
        tools.exec_command({ cmd: "bun run test" }),
        tools.view_image({ path: "/tmp/result.png" }),
      ]);
      text(test.output);
      image(image.image_url);
    `)

    expect(presentation).toEqual({
      label: "Run tools",
      summary: "Run command · View image",
      styleName: "exec",
    })
    expect(presentation.summary).not.toContain("const")
    expect(presentation.summary).not.toContain("tools.")
  })

  it("falls back gracefully for a custom code-mode script", () => {
    expect(execPresentation("text('no nested tool')")).toEqual({
      label: "Run tool script",
      summary: "",
      styleName: "exec",
    })
  })

  it("identifies native Codex web-search action variants", () => {
    expect(getToolPresentation({
      name: "WebSearch",
      input: { action: { type: "openPage", url: "https://example.com/docs" } },
    })).toMatchObject({ label: "Open page", summary: "https://example.com/docs" })
    expect(getToolPresentation({
      name: "WebSearch",
      input: { action: { type: "find_in_page", url: "https://example.com", pattern: "schema" } },
    })).toMatchObject({ label: "Find on page", summary: "schema · https://example.com" })
  })
})
