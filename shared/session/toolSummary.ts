/**
 * One-line renderings of tool calls.
 *
 * Codex code mode persists orchestration as a `custom_tool_call` named `exec`.
 * The useful operation is inside that script (`tools.web__run(...)`,
 * `tools.exec_command(...)`, an MCP call, and so on), so presentation must be
 * derived from the nested calls instead of showing the JavaScript source.
 */

import {
  countJsCollectionEntries,
  extractCodexExecInvocations,
  extractJsNumberPropertyValues,
  extractJsPropertySource,
  extractJsStringPropertyValues,
  readJsStringLiteral,
  type CodexExecInvocation,
} from "./codex-exec"

/** Minimal shape needed to present a call — satisfied by a parsed ToolCall. */
export interface SummarizableToolCall {
  name: string
  input: Record<string, unknown>
}

export interface ToolPresentation {
  /** Human-facing operation, such as "Search web" or "Run command". */
  label: string
  /** Concise target/query shown next to the operation. */
  summary: string
  /** Existing timeline color family to use for this semantic operation. */
  styleName: string
}

interface WebOperation {
  label: string
  summary: string
  count: number
  noun: string
}

const CODEX_TOOL_LABELS: Readonly<Record<string, { label: string; styleName: string }>> = {
  spawn_agent: { label: "Spawn agent", styleName: "Task" },
  wait_agent: { label: "Wait for agents", styleName: "Task" },
  send_message: { label: "Message agent", styleName: "Task" },
  followup_task: { label: "Follow up", styleName: "Task" },
  list_agents: { label: "List agents", styleName: "Task" },
  interrupt_agent: { label: "Interrupt agent", styleName: "Task" },
  tool_search: { label: "Find tools", styleName: "ToolSearch" },
  list_mcp_resources: { label: "List MCP resources", styleName: "Mcp" },
  list_mcp_resource_templates: { label: "List MCP templates", styleName: "Mcp" },
  read_mcp_resource: { label: "Read MCP resource", styleName: "Mcp" },
  request_plugin_install: { label: "Install plugin", styleName: "Mcp" },
  create_goal: { label: "Create goal", styleName: "TodoWrite" },
  get_goal: { label: "Check goal", styleName: "TodoWrite" },
  update_goal: { label: "Update goal", styleName: "TodoWrite" },
  view_image: { label: "View image", styleName: "Read" },
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? ""
}

function truncate(value: string, length = 140): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length > length ? `${singleLine.slice(0, length - 1)}…` : singleLine
}

function unique(values: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function compactValues(values: string[], fallback = ""): string {
  const items = unique(values)
  if (items.length === 0) return fallback
  const first = truncate(items[0])
  return items.length === 1 ? first : `${first} · +${items.length - 1} more`
}

function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`
  return `${count} ${noun}${/(?:ch|sh|s|x|z)$/.test(noun) ? "es" : "s"}`
}

const WORD_SPELLINGS: Readonly<Record<string, string>> = {
  mcp: "MCP",
  api: "API",
  url: "URL",
  openai: "OpenAI",
  figma: "Figma",
  clickup: "ClickUp",
}

function humanizeIdentifier(value: string, titleCase = false): string {
  const words = value
    .replace(/^mcp__/, "")
    .replace(/__/g, " ")
    .replace(/[_./:-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase()
      if (WORD_SPELLINGS[lower]) return WORD_SPELLINGS[lower]
      return titleCase ? lower[0].toUpperCase() + lower.slice(1) : lower
    })
  if (words.length === 0) return "Tool"
  const text = words.join(" ")
  return text[0].toUpperCase() + text.slice(1)
}

function stringExpression(source: string | null): string | null {
  if (!source) return null
  const trimmed = source.trim()
  const literal = readJsStringLiteral(trimmed, 0)
  return literal?.endIndex === trimmed.length ? literal.value : null
}

function argumentString(args: string, ...properties: string[]): string {
  for (const property of properties) {
    const direct = stringExpression(extractJsPropertySource(args, property))
    if (direct) return direct
    const nested = extractJsStringPropertyValues(args, property)[0]
    if (nested) return nested
  }
  return ""
}

function argumentNumber(args: string, ...properties: string[]): number | null {
  for (const property of properties) {
    const number = extractJsNumberPropertyValues(args, property)[0]
    if (number !== undefined) return number
  }
  return null
}

function invocationDetail(args: string): string {
  return argumentString(
    args,
    "description",
    "query",
    "q",
    "cmd",
    "command",
    "file_path",
    "path",
    "uri",
    "url",
    "pattern",
    "prompt",
    "objective",
    "message",
    "location",
    "ticker",
    "target",
    "task_name",
    "plugin_id",
    "server",
    "status",
    "id",
  )
}

interface WebOperationSpec {
  /** Property present in the `web__run` argument when this operation ran. */
  key: string
  label: string
  /** Noun used when one call mixes operations: "2 searches · 1 page". */
  noun: string
  /** String properties summarized together, one summary segment per group. */
  summaryGroups: string[][]
  /** Numeric property appended to the summary, such as "line 830". */
  detail?: { property: string; format: (value: number) => string }
  /** Properties counted as one entry each; defaults to the first summary group. */
  countProperties?: string[]
}

const WEB_OPERATIONS: readonly WebOperationSpec[] = [
  { key: "search_query", label: "Search web", noun: "search", summaryGroups: [["q", "query"]] },
  { key: "image_query", label: "Search images", noun: "image search", summaryGroups: [["q", "query"]] },
  {
    key: "open",
    label: "Open page",
    noun: "page",
    summaryGroups: [["ref_id", "url"]],
    detail: { property: "lineno", format: (line) => `line ${line}` },
  },
  {
    key: "click",
    label: "Open link",
    noun: "link",
    summaryGroups: [["ref_id"]],
    detail: { property: "id", format: (id) => `link ${id}` },
  },
  { key: "find", label: "Find on page", noun: "find", summaryGroups: [["pattern"], ["ref_id", "url"]] },
  {
    key: "screenshot",
    label: "Capture page",
    noun: "capture",
    summaryGroups: [["ref_id"]],
    detail: { property: "pageno", format: (page) => `page ${page + 1}` },
  },
  { key: "finance", label: "Check markets", noun: "quote", summaryGroups: [["ticker"]] },
  { key: "weather", label: "Check weather", noun: "forecast", summaryGroups: [["location"]] },
  {
    key: "sports",
    label: "Check sports",
    noun: "sports lookup",
    summaryGroups: [["league", "team"]],
    countProperties: ["league"],
  },
  { key: "time", label: "Check time", noun: "time lookup", summaryGroups: [["utc_offset"]] },
]

function stringValues(source: string, properties: string[]): string[] {
  return properties.flatMap((property) => extractJsStringPropertyValues(source, property))
}

function describeWebOperation(source: string, spec: WebOperationSpec): WebOperation {
  const groups = spec.summaryGroups.map((properties) => stringValues(source, properties))
  const details = spec.detail ? extractJsNumberPropertyValues(source, spec.detail.property) : []
  const counted = spec.countProperties ? stringValues(source, spec.countProperties) : groups[0]
  return {
    label: spec.label,
    noun: spec.noun,
    summary: [
      ...groups.map((values) => compactValues(values)),
      spec.detail && details.length > 0 ? spec.detail.format(details[0]) : "",
    ].filter(Boolean).join(" · "),
    count: Math.max(countJsCollectionEntries(source), unique(counted).length, details.length, 1),
  }
}

function webOperations(args: string): WebOperation[] {
  const operations: WebOperation[] = []
  for (const spec of WEB_OPERATIONS) {
    const source = extractJsPropertySource(args, spec.key)
    if (source) operations.push(describeWebOperation(source, spec))
  }
  return operations
}

function presentWebInvocation(args: string): ToolPresentation {
  const operations = webOperations(args)
  if (operations.length === 0) {
    return { label: "Browse web", summary: invocationDetail(args), styleName: "WebSearch" }
  }
  if (operations.length === 1) {
    return { label: operations[0].label, summary: operations[0].summary, styleName: "WebSearch" }
  }
  return {
    label: "Browse web",
    summary: operations.map((operation) => plural(operation.count, operation.noun)).join(" · "),
    styleName: "WebSearch",
  }
}

function mcpParts(name: string): { server: string; action: string } | null {
  if (!name.startsWith("mcp__")) return null
  const [, server, ...actionParts] = name.split("__")
  if (!server || actionParts.length === 0) return null
  return {
    server: humanizeIdentifier(server, true),
    action: humanizeIdentifier(actionParts.join(" ")),
  }
}

function presentMcpInvocation(name: string, args: string): ToolPresentation {
  const parts = mcpParts(name)
  if (!parts) {
    return { label: humanizeIdentifier(name), summary: invocationDetail(args), styleName: "Mcp" }
  }
  const detail = invocationDetail(args)
  return {
    label: parts.server,
    summary: [parts.action, detail].filter(Boolean).join(" · "),
    styleName: "Mcp",
  }
}

function patchSummary(args: string): string {
  const literal = readJsStringLiteral(args.trim(), 0)
  const patch = literal?.value ?? args
  const paths = unique(Array.from(
    patch.matchAll(/^\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)$/gm),
    (match) => match[1],
  ))
  return compactValues(paths, paths.length > 0 ? plural(paths.length, "file") : "")
}

function presentExecInvocation(invocation: CodexExecInvocation): ToolPresentation {
  const args = invocation.argumentSource
  switch (invocation.name) {
    case "exec_command":
      return { label: "Run command", summary: argumentString(args, "cmd", "command"), styleName: "Bash" }
    case "write_stdin": {
      const sessionId = argumentNumber(args, "session_id")
      const chars = argumentString(args, "chars")
      return {
        label: "Continue command",
        summary: [sessionId !== null ? `session ${sessionId}` : "", chars ? truncate(chars, 60) : ""].filter(Boolean).join(" · "),
        styleName: "Bash",
      }
    }
    case "apply_patch":
      return { label: "Apply patch", summary: patchSummary(args), styleName: "Edit" }
    case "web__run":
    case "web_search":
      return presentWebInvocation(args)
    case "view_image":
      return { label: "View image", summary: argumentString(args, "path"), styleName: "Read" }
    case "update_plan": {
      const plan = extractJsPropertySource(args, "plan")
      const count = plan ? countJsCollectionEntries(plan) : 0
      return {
        label: "Update plan",
        summary: count > 0 ? plural(count, "step") : argumentString(args, "explanation"),
        styleName: "TodoWrite",
      }
    }
    case "create_goal":
      return { label: "Create goal", summary: argumentString(args, "objective"), styleName: "TodoWrite" }
    case "get_goal":
      return { label: "Check goal", summary: "", styleName: "TodoWrite" }
    case "update_goal":
      return { label: "Update goal", summary: argumentString(args, "status"), styleName: "TodoWrite" }
    case "list_mcp_resources":
      return { label: "List MCP resources", summary: argumentString(args, "server"), styleName: "Mcp" }
    case "list_mcp_resource_templates":
      return { label: "List MCP templates", summary: argumentString(args, "server"), styleName: "Mcp" }
    case "read_mcp_resource":
      return {
        label: "Read MCP resource",
        summary: [argumentString(args, "server"), argumentString(args, "uri")].filter(Boolean).join(" · "),
        styleName: "Mcp",
      }
    case "request_plugin_install":
      return { label: "Install plugin", summary: argumentString(args, "plugin_id"), styleName: "Mcp" }
    case "tool_search":
      return { label: "Find tools", summary: argumentString(args, "query"), styleName: "ToolSearch" }
    case "image_gen__imagegen":
      return { label: "Generate image", summary: argumentString(args, "prompt"), styleName: "Image" }
    default:
      return invocation.name.startsWith("mcp__")
        ? presentMcpInvocation(invocation.name, args)
        : {
            label: humanizeIdentifier(invocation.name),
            summary: invocationDetail(args),
            styleName: invocation.name,
          }
  }
}

/** Codex code mode wraps a whole orchestration script in one `exec` tool call. */
export function isCodexExecCall(
  tc: SummarizableToolCall,
): tc is SummarizableToolCall & { input: { raw: string } } {
  return typeof tc.input.raw === "string" && /(?:^|__|[.:/])exec$/.test(tc.name)
}

function presentExecScript(script: string): ToolPresentation {
  const calls = extractCodexExecInvocations(script)
  if (calls.length === 0) {
    return { label: "Run tool script", summary: "", styleName: "exec" }
  }

  const presentations = calls.map(presentExecInvocation)
  const first = presentations[0]
  // Multiplicity belongs in the summary: callers group by label and append their
  // own ×count, so a label carrying one would render "Run command ×3 ×2".
  if (presentations.every((item) => item.label === first.label)) {
    const summary = compactValues(presentations.map((item) => item.summary))
    return {
      label: first.label,
      summary: calls.length === 1
        ? summary
        : [`×${calls.length}`, summary].filter(Boolean).join(" · "),
      styleName: first.styleName,
    }
  }

  const counts = new Map<string, number>()
  for (const item of presentations) counts.set(item.label, (counts.get(item.label) ?? 0) + 1)
  return {
    label: "Run tools",
    summary: [...counts].map(([label, count]) => count > 1 ? `${label} ×${count}` : label).join(" · "),
    styleName: "exec",
  }
}

function nativeWebPresentation(input: Record<string, unknown>): ToolPresentation {
  const action = isObject(input.action) ? input.action : null
  const type = typeof action?.type === "string" ? action.type : "search"
  if (type === "open_page" || type === "openPage") {
    return {
      label: "Open page",
      summary: firstString(action?.url, input.query),
      styleName: "WebSearch",
    }
  }
  if (type === "find_in_page" || type === "findInPage") {
    return {
      label: "Find on page",
      summary: [firstString(action?.pattern), firstString(action?.url)].filter(Boolean).join(" · "),
      styleName: "WebSearch",
    }
  }
  const queries = Array.isArray(action?.queries)
    ? action.queries.filter((query): query is string => typeof query === "string")
    : []
  const query = firstString(action?.query, input.query)
  return {
    label: "Search web",
    summary: compactValues([query, ...queries]),
    styleName: "WebSearch",
  }
}

/** Payload keys that schema-free tools use for a human-facing gist. */
const SCHEMA_FREE_GIST_KEYS = ["summary", "headline", "verdict", "title"] as const

/**
 * Some tools carry a caller-defined payload with no fixed fields. Lead with a
 * gist the payload names itself; failing that, count whatever it collected.
 */
function schemaFreeSummary(input: Record<string, unknown>): string {
  const gist = firstString(...SCHEMA_FREE_GIST_KEYS.map((key) => input[key]))
  if (gist) return truncate(gist)
  for (const [key, value] of Object.entries(input)) {
    if (!Array.isArray(value)) continue
    const noun = value.length === 1 && key.endsWith("s") ? key.slice(0, -1) : key
    return `${value.length} ${noun}`
  }
  return ""
}

/** Workflow calls carry a script, not a name; the run's name lives in its meta. */
function workflowSummary(input: Record<string, unknown>): string {
  const description = firstString(input.description)
  if (description) return truncate(description)
  const script = firstString(input.script)
  const metaName = script ? extractJsStringPropertyValues(script, "name")[0] ?? "" : ""
  return metaName || firstString(input.scriptPath)
}

/** Last resort for an unrecognised tool: the first string its input carries. */
function firstStringValue(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return ""
  const first = input[keys[0]]
  if (typeof first !== "string") return ""
  return first.length > 80 ? first.slice(0, 80) + "..." : first
}

function defaultToolSummary(tc: SummarizableToolCall): string {
  const input = tc.input
  switch (tc.name) {
    case "Read":
    case "Write":
    case "Edit":
      return String(input.file_path ?? input.path ?? "")
    case "Bash":
      return String(input.command ?? input.cmd ?? "")
    case "Grep":
    case "Glob":
      return String(input.pattern ?? "")
    case "Task":
    case "Agent":
      return String(input.description ?? input.prompt ?? "")
    case "WebFetch":
      return String(input.url ?? "")
    case "NotebookEdit":
      return String(input.notebook_path ?? "")
    case "EnterPlanMode":
      return "Entered plan mode"
    case "ExitPlanMode":
      return "Waiting for plan approval"
    case "AskUserQuestion": {
      const questions = input.questions as Array<{ question?: string }> | undefined
      return questions?.[0]?.question ?? ""
    }
    case "Monitor": {
      const bashId = String(input.bash_id ?? "")
      const filter = input.filter ? ` · filter=${input.filter}` : ""
      return `${bashId}${filter}`
    }
    case "CronCreate": {
      const sched = String(input.schedule ?? input.cron ?? "")
      const prompt = String(input.prompt ?? "")
      const trimmed = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt
      return sched && trimmed ? `${sched} → ${trimmed}` : sched || trimmed
    }
    case "CronList":
      return ""
    case "CronDelete":
      return String(input.id ?? input.cron_id ?? "")
    case "ScheduleWakeup": {
      const sec = Number(input.delaySeconds ?? 0)
      const m = Math.round(sec / 60)
      const human = sec >= 3600 ? `${Math.round(sec / 3600)}h` : sec >= 60 ? `${m}m` : `${sec}s`
      const reason = input.reason ? ` · ${input.reason}` : ""
      return `in ${human}${reason}`
    }
    case "RemoteTrigger": {
      const action = String(input.action ?? "")
      const id = String(input.id ?? input.trigger_id ?? "")
      return [action, id].filter(Boolean).join(" ")
    }
    case "PushNotification":
      return String(input.title ?? input.body ?? "")
    case "EnterWorktree": {
      const name = String(input.name ?? input.branch ?? "")
      const path = input.path ? ` (${input.path})` : ""
      return `${name}${path}`
    }
    case "ExitWorktree":
      return String(input.name ?? input.branch ?? "")
    case "Skill":
      return String(input.skill ?? input.name ?? "")
    case "ToolSearch":
      return String(input.query ?? "")
    case "SendMessage": {
      const recipient = firstString(input.to, input.recipient)
      const gist = truncate(firstString(input.summary, input.message, input.content))
      return [recipient, gist].filter(Boolean).join(" · ")
    }
    case "ListAgents":
    case "TaskList":
      return ""
    case "TaskCreate":
      return truncate(firstString(input.subject, input.description))
    case "TaskUpdate": {
      const taskId = String(input.taskId ?? "")
      const blockers = Array.isArray(input.addBlockedBy)
        ? input.addBlockedBy.filter((id): id is string => typeof id === "string")
        : []
      const change = firstString(input.status)
        || (blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : "")
      return change ? `${taskId} → ${change}` : taskId
    }
    case "TaskOutput":
    case "TaskStop":
      return String(input.task_id ?? "")
    case "Workflow":
      return workflowSummary(input)
    case "StructuredOutput":
    case "ReportFindings":
    case "DesignSync":
    case "Artifact":
    case "LSP":
      return schemaFreeSummary(input) || firstStringValue(input)
    case "spawn_agent":
      return String(input.task_name ?? input.message ?? "")
    case "wait_agent": {
      const targets = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string") : []
      return compactValues(targets)
    }
    case "send_message":
    case "followup_task":
      return [input.target, input.message].filter((value): value is string => typeof value === "string").join(" · ")
    case "list_agents":
      return String(input.path_prefix ?? "")
    case "interrupt_agent":
      return String(input.target ?? "")
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      return String(input.server ?? "")
    case "read_mcp_resource":
      return [input.server, input.uri].filter((value): value is string => typeof value === "string").join(" · ")
    case "request_plugin_install":
      return String(input.plugin_id ?? "")
    case "create_goal":
      return String(input.objective ?? "")
    case "update_goal":
      return String(input.status ?? "")
    case "view_image":
      return String(input.path ?? "")
    default:
      return firstStringValue(input)
  }
}

export function getToolPresentation(tc: SummarizableToolCall): ToolPresentation {
  if (isCodexExecCall(tc)) return presentExecScript(tc.input.raw)
  if (tc.name === "WebSearch") return nativeWebPresentation(tc.input)

  const mcp = mcpParts(tc.name)
  if (mcp) {
    return {
      label: mcp.server,
      summary: [mcp.action, defaultToolSummary(tc)].filter(Boolean).join(" · "),
      styleName: "Mcp",
    }
  }

  const codex = CODEX_TOOL_LABELS[tc.name]
  return {
    label: codex?.label ?? tc.name,
    summary: defaultToolSummary(tc),
    styleName: codex?.styleName ?? tc.name,
  }
}

export function getToolSummary(tc: SummarizableToolCall): string {
  return getToolPresentation(tc).summary
}
