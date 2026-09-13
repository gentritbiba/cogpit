import type { ThinkingBlock, ToolCall } from "../../shared/session/types"
import { getCommandText, getToolPresentation } from "../../shared/session/toolSummary"
import { analyzeSection, parseSectionedCommand } from "./sectionedCommand"
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
    failed: 0,
    running: 0,
    unavailable: 0,
    groups: [],
    text: "",
  }

  for (const toolCall of toolCalls) {
    if (toolCallFailed(toolCall)) summary.failed++
    else if (toolCall.result !== null) summary.completed++
    else if (isAgentActive) summary.running++
    else summary.unavailable++

    const { label } = getToolPresentation(toolCall)
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
      toolCallFailed(entry.toolCall) || (isAgentActive && entry.toolCall.result === null)
    )
  ))
  return { visible, hidden: entries.length - visible.length }
}
