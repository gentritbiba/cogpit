/**
 * How each agent is *shown*. Icons are React components and prose is
 * user-visible copy, so neither can live in `shared/session` — but everything
 * here is still keyed by `AgentKind` through a total `Record`, so adding a
 * fourth agent is a type error rather than a silently missing row. That is the
 * bug that let Copilot fall out of the config badge map.
 */
import { Github } from "lucide-react"
import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react"
import type { PermissionMode } from "../permissions"
import { AGENT_KINDS, descriptorForDirName, type AgentKind } from "."
import { AnthropicIcon, OpenAIIcon } from "./brandIcons"

/** Any SVG component that takes the same props as a lucide icon. */
export type AgentIcon = ForwardRefExoticComponent<SVGProps<SVGSVGElement> & RefAttributes<SVGSVGElement>>

/** Each agent's vendor mark, since the product names alone don't say who runs the model. */
const ICONS: Record<AgentKind, AgentIcon> = {
  claude: AnthropicIcon,
  codex: OpenAIIcon,
  copilot: Github,
}

/** Short name for chips and dropdown rows, where the full product name is too long. */
const SHORT_NAMES: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
}

/** Name used when the row has space, e.g. the project switcher's folder hint. */
const SWITCHER_NAMES: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
}

/**
 * Badge shown on a project row. Claude is the unmarked default, so a row with
 * no badge means Claude rather than "unknown".
 */
const PROJECT_BADGES: Record<AgentKind, string | null> = {
  claude: null,
  codex: "Codex",
  copilot: "Copilot",
}

/** Single letter plus tooltip for the config browser's "loaded by" badge. */
const CONFIG_BADGES: Record<AgentKind, { letter: string; label: string }> = {
  claude: { letter: "C", label: "Loaded by Claude Code" },
  codex: { letter: "X", label: "Loaded by Codex CLI" },
  copilot: { letter: "G", label: "Loaded by GitHub Copilot CLI" },
}

/** Series colour, so one agent keeps one colour across every chart and legend. */
const CHART_COLORS: Record<AgentKind, string> = {
  claude: "var(--chart-1)",
  codex: "var(--chart-2)",
  copilot: "var(--chart-3)",
}

/** What the composer's interrupt button says while a turn is running. */
const INTERRUPT_LABELS: Record<AgentKind, string> = {
  claude: "Interrupt agent",
  codex: "Stop active turn",
  copilot: "Stop Copilot turn",
}

export interface PermissionModeOption {
  value: PermissionMode
  label: string
  description: string
}

/**
 * Cogpit's access picker, in each agent's own words: the same wire modes,
 * labelled the way that CLI's policy actually behaves.
 */
const PERMISSION_MODES: Record<AgentKind, readonly PermissionModeOption[]> = {
  claude: [
    { value: "default", label: "Ask", description: "Ask before sensitive actions" },
    { value: "plan", label: "Plan", description: "Read and plan without changing files" },
    { value: "acceptEdits", label: "Accept Edits", description: "Allow file edits; ask for other actions" },
    { value: "auto", label: "Auto", description: "Run autonomously with classifier safeguards" },
    { value: "dontAsk", label: "Don't Ask", description: "Deny actions that need approval" },
    { value: "bypassPermissions", label: "Full access", description: "Skip permission checks" },
  ],
  codex: [
    { value: "default", label: "Workspace", description: "Write inside the project sandbox" },
    { value: "plan", label: "Read only", description: "Inspect and plan without writing" },
    { value: "bypassPermissions", label: "Full access", description: "No sandbox or approval checks" },
  ],
  copilot: [
    { value: "default", label: "Ask", description: "Ask before running tools or changing files" },
    { value: "plan", label: "Plan", description: "Explore and plan without changing project files" },
    { value: "auto", label: "Autopilot", description: "Implement autonomously until the task is complete" },
    { value: "bypassPermissions", label: "Full access", description: "Allow tools, paths, and URLs without asking" },
  ],
}

export function agentPermissionModes(kind: AgentKind): readonly PermissionModeOption[] {
  return PERMISSION_MODES[kind]
}

export function agentIcon(kind: AgentKind): AgentIcon {
  return ICONS[kind]
}

export function agentShortName(kind: AgentKind): string {
  return SHORT_NAMES[kind]
}

export function agentSwitcherName(kind: AgentKind): string {
  return SWITCHER_NAMES[kind]
}

export function agentProjectBadge(kind: AgentKind): string | null {
  return PROJECT_BADGES[kind]
}

export function agentConfigBadge(kind: AgentKind): { letter: string; label: string } {
  return CONFIG_BADGES[kind]
}

export function agentInterruptLabel(kind: AgentKind): string {
  return INTERRUPT_LABELS[kind]
}

export function agentChartColor(kind: AgentKind): string {
  return CHART_COLORS[kind]
}

/**
 * Order for legends and breakdowns: the agent that owns every unprefixed
 * project first, then the rest in registry order. Detection order puts that
 * agent last, which reads oddly where it is usually the largest series.
 */
const DEFAULT_KIND = descriptorForDirName(null).kind
export const AGENT_DISPLAY_ORDER: readonly AgentKind[] = [
  DEFAULT_KIND,
  ...AGENT_KINDS.filter((kind) => kind !== DEFAULT_KIND),
]

/** Banner shown when another process owns the session and Cogpit can only read it. */
export function readOnlySessionNotice(kind: AgentKind): string {
  return `This ${SHORT_NAMES[kind]} session is controlled by another process. Cogpit can only view it.`
}

/**
 * Every agent as a pickable composer row, in display order — not registry
 * order, which is transcript-detection order and would put the default agent
 * last in the picker.
 */
export const AGENT_OPTIONS: ReadonlyArray<{
  value: AgentKind
  label: string
  Icon: AgentIcon
}> = AGENT_DISPLAY_ORDER.map((kind) => ({
  value: kind,
  label: SHORT_NAMES[kind],
  Icon: ICONS[kind],
}))
