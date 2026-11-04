import type { ThinkingBlock, ToolCall } from "../../shared/session/types"
import { getCommandText, getToolPresentation } from "../../shared/session/toolSummary"
import { analyzeSection, parseSectionedCommand } from "./sectionedCommand"
import { describeCrewCall } from "./crewCommands"
import type { ActivityItem } from "./timelineHelpers"

export type ToolActivityEntry =
  | { kind: "tool_call"; toolCall: ToolCall }
  | { kind: "thinking"; blocks: ThinkingBlock[] }

export interface ToolActivityGroup {
  label: string
  count: number
  text: string
}

export interface ToolActivitySummary {
  total: number
  completed: number
  awaitingReview: number
  failed: number
  running: number
  unavailable: number
  groups: ToolActivityGroup[]
  text: string
}

const OPERATION_NOUNS: Readonly<Record<string, [string, string]>> = {
  "Read file": ["read", "reads"],
  "Write file": ["write", "writes"],
  "Edit file": ["edit", "edits"],
  "Apply patch": ["edit", "edits"],
  "Edit notebook": ["edit", "edits"],
  "Run command": ["command", "commands"],
  "Continue command": ["command", "commands"],
  "Search files": ["search", "searches"],
  "Find files": ["search", "searches"],
  "Search web": ["search", "searches"],
  "Search images": ["image search", "image searches"],
  "Open page": ["page", "pages"],
  "Open link": ["page", "pages"],
  "View image": ["image", "images"],
  "Spawn agent": ["agent", "agents"],
  "Message agent": ["message", "messages"],
  "Ask question": ["question", "questions"],
  "Use skill": ["skill", "skills"],
  "Update plan": ["plan update", "plan updates"],
  "Run tools": ["tool batch", "tool batches"],
  "Run tool script": ["tool script", "tool scripts"],
  Crew: ["crew call", "crew calls"],
}

/** "Crew" for a shell command that drives a crew, else the call's own operation. */
function operationLabel(toolCall: ToolCall): string {
  const { label, styleName } = getToolPresentation(toolCall)
  if (styleName !== "Bash") return label
  const command = getCommandText(toolCall.input)
  return command && describeCrewCall(command, toolCall.result) ? "Crew" : label
}

export function toolCallFailed(toolCall: ToolCall): boolean {
  if (toolCall.isError) return true
  const command = getCommandText(toolCall.input)
  if (!command || toolCall.result === null || getToolPresentation(toolCall).styleName !== "Bash") return false
  return parseSectionedCommand(command, toolCall.result)?.some((section) => analyzeSection(section).failed) ?? false
}

export function summarizeToolActivity(
  toolCalls: readonly ToolCall[],
  isAgentActive = false,
): ToolActivitySummary {
  const counts = new Map<string, { count: number; nouns?: [string, string] }>()
  const summary: ToolActivitySummary = {
    total: toolCalls.length,
    completed: 0,
    awaitingReview: 0,
    failed: 0,
    running: 0,
    unavailable: 0,
    groups: [],
    text: "",
  }

  for (const toolCall of toolCalls) {
    if (toolCallFailed(toolCall)) summary.failed++
    else if (toolCall.awaitingReview) summary.awaitingReview++
    else if (toolCall.result !== null) summary.completed++
    else if (isAgentActive) summary.running++
    else summary.unavailable++

    const label = operationLabel(toolCall)
    const nouns = OPERATION_NOUNS[label]
    const key = nouns?.[0] ?? label
    const existing = counts.get(key)
    if (existing) existing.count++
    else counts.set(key, { count: 1, nouns })
  }

  summary.groups = [...counts].map(([label, { count, nouns }]) => ({
    label,
    count,
    text: nouns ? `${count} ${nouns[count === 1 ? 0 : 1]}` : `${label} ×${count}`,
  }))
  summary.text = summary.groups.map((group) => group.text).join(" · ")
  return summary
}

export function toolActivityEntries(
  toolCalls: readonly ToolCall[],
  activityItems?: readonly ActivityItem[],
): ToolActivityEntry[] {
  if (!activityItems) return toolCalls.map((toolCall) => ({ kind: "tool_call", toolCall }))
  return activityItems.flatMap<ToolActivityEntry>((item) => item.kind === "thinking"
    ? item.blocks.map((block) => ({ kind: "thinking", blocks: [block] }))
    : item.toolCalls.map((toolCall) => ({ kind: "tool_call", toolCall })))
}

export const MAX_LIVE_TOOL_ACTIVITY_ENTRIES = 3

export function visibleToolActivity(
  entries: readonly ToolActivityEntry[],
  tailOnly: boolean,
  isAgentActive = false,
): { visible: ToolActivityEntry[]; hidden: number } {
  if (!tailOnly) return { visible: [...entries], hidden: 0 }
  const tailStart = entries.length - MAX_LIVE_TOOL_ACTIVITY_ENTRIES
  const visible = entries.filter((entry, index) => index >= tailStart || (
    entry.kind === "tool_call" && (
      toolCallFailed(entry.toolCall) || entry.toolCall.awaitingReview || (isAgentActive && entry.toolCall.result === null)
    )
  ))
  return { visible, hidden: entries.length - visible.length }
}

/** What a finished call did, as the verb that starts its row: "Read", "Ran", "Edited". */
const PAST_VERBS: Readonly<Record<string, string>> = {
  "Read file": "Read",
  "Write file": "Wrote",
  "Edit file": "Edited",
  "Apply patch": "Edited",
  "Edit notebook": "Edited",
  "Run command": "Ran",
  "Continue command": "Continued",
  "Search files": "Searched",
  "Find files": "Found files",
  "Search web": "Searched the web",
  "Search images": "Searched images",
  "Open page": "Opened",
  "Open link": "Opened",
  "Find on page": "Found on page",
  "Capture page": "Captured",
  "View image": "Viewed",
  "Spawn agent": "Started agent",
  "Message agent": "Messaged",
  "Ask question": "Asked",
  "Use skill": "Used skill",
  "Update plan": "Updated plan",
  "Find tools": "Loaded tools",
  "Wait for agents": "Waited for agents",
  "Wait for tools": "Waited",
  "Run workflow": "Ran workflow",
}

/** The same verbs while the call is still running. */
const PRESENT_VERBS: Readonly<Record<string, string>> = {
  "Read file": "Reading",
  "Write file": "Writing",
  "Edit file": "Editing",
  "Apply patch": "Editing",
  "Edit notebook": "Editing",
  "Run command": "Running",
  "Continue command": "Running",
  "Search files": "Searching",
  "Find files": "Finding files",
  "Search web": "Searching the web",
  "Open page": "Opening",
  "Open link": "Opening",
  "View image": "Viewing",
  "Spawn agent": "Starting agent",
  "Message agent": "Messaging",
  "Ask question": "Asking",
  "Use skill": "Using skill",
  "Update plan": "Updating plan",
  "Find tools": "Loading tools",
  "Wait for agents": "Waiting for agents",
  "Wait for tools": "Waiting",
  "Run workflow": "Running workflow",
}

/** The verb a tool row opens with, in the tense its state calls for; other tools keep their own label. */
export function toolVerb(label: string, running: boolean): string {
  return (running ? PRESENT_VERBS[label] : PAST_VERBS[label]) ?? label
}

const GROUP_PHRASES: Readonly<Record<string, (count: number) => string>> = {
  read: (count) => `read ${count} ${count === 1 ? "file" : "files"}`,
  write: (count) => `wrote ${count} ${count === 1 ? "file" : "files"}`,
  edit: (count) => `made ${count} ${count === 1 ? "edit" : "edits"}`,
  command: (count) => `ran ${count} ${count === 1 ? "command" : "commands"}`,
  search: (count) => `searched ${count === 1 ? "once" : `${count} times`}`,
  page: (count) => `opened ${count} ${count === 1 ? "page" : "pages"}`,
  image: (count) => `viewed ${count} ${count === 1 ? "image" : "images"}`,
  agent: (count) => `started ${count} ${count === 1 ? "agent" : "agents"}`,
  message: (count) => `sent ${count} ${count === 1 ? "message" : "messages"}`,
  question: (count) => `asked ${count} ${count === 1 ? "question" : "questions"}`,
  skill: (count) => `used ${count} ${count === 1 ? "skill" : "skills"}`,
  "plan update": () => "updated the plan",
  "crew call": (count) => `made ${count} crew ${count === 1 ? "call" : "calls"}`,
}

/** A group's activity as one sentence: "Ran 3 commands, read 2 files, made 1 edit". */
export function activitySentence(summary: ToolActivitySummary, thoughtForMs = 0, thinkingCount = 0): string {
  const phrases = summary.groups.map(({ label, count }) => GROUP_PHRASES[label]?.(count) ?? `used ${label}${count > 1 ? ` ×${count}` : ""}`)
  if (thoughtForMs >= 1000) phrases.push(`thought for ${Math.round(thoughtForMs / 1000)}s`)
  else if (thinkingCount > 0 && phrases.length === 0) phrases.push("thought")
  const sentence = phrases.join(", ")
  return sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : "Worked"
}
