import { BookOpen, Bot, Sparkles, Terminal, FileJson } from "lucide-react"

// ── Types ──────────────────────────────────────────────────────────────

export interface ConfigTreeItem {
  name: string
  path: string
  type: "file" | "directory"
  fileType?: "command" | "skill" | "agent" | "claude-md" | "settings" | "unknown"
  description?: string
  children?: ConfigTreeItem[]
  readOnly?: boolean
}

export interface ConfigTreeSection {
  label: string
  scope: "global" | "project" | "plugin"
  pluginName?: string
  baseDir?: string
  items: ConfigTreeItem[]
}

/** A flattened config item for the category view and editor selection */
export interface ConfigItem {
  name: string
  path: string
  fileType: string
  description: string
  scope: "global" | "project" | "plugin" | string
  pluginName?: string
  readOnly: boolean
}

export type Category = "instructions" | "agents" | "skills" | "commands" | "settings"

// ── Constants ──────────────────────────────────────────────────────────

export const BADGE_COLORS: Record<string, string> = {
  agent: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  skill: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  command: "bg-green-500/20 text-green-300 border-green-500/30",
  "claude-md": "bg-blue-500/20 text-blue-300 border-blue-500/30",
  settings: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
}

export const CATEGORY_DIR_MAP: Record<string, { subdir: string; fileType: "command" | "skill" | "agent" }> = {
  agents: { subdir: "agents", fileType: "agent" },
  skills: { subdir: "skills", fileType: "skill" },
  commands: { subdir: "commands", fileType: "command" },
}

export const CATEGORY_ORDER: Category[] = ["instructions", "agents", "skills", "commands", "settings"]

export const CATEGORY_META: Record<Category, { label: string; icon: typeof BookOpen; color: string }> = {
  instructions: { label: "Instructions", icon: BookOpen, color: "text-blue-400" },
  agents: { label: "Agents", icon: Bot, color: "text-purple-400" },
  skills: { label: "Skills", icon: Sparkles, color: "text-amber-400" },
  commands: { label: "Commands", icon: Terminal, color: "text-green-400" },
  settings: { label: "Settings", icon: FileJson, color: "text-cyan-400" },
}

// ── Helpers ────────────────────────────────────────────────────────────

export function flattenItems(
  items: ConfigTreeItem[],
  scope: ConfigTreeSection["scope"],
  pluginName?: string,
): ConfigItem[] {
  const result: ConfigItem[] = []
  for (const item of items) {
    if (item.type === "directory" && item.children) {
      result.push(...flattenItems(item.children, scope, pluginName))
    } else if (item.type === "file") {
      result.push({
        name: item.name,
        path: item.path,
        fileType: item.fileType || "unknown",
        description: item.description || "",
        scope,
        pluginName,
        readOnly: item.readOnly ?? (scope === "plugin"),
      })
    }
  }
  return result
}

export function categorizeItems(sections: ConfigTreeSection[]): Record<Category, ConfigItem[]> {
  const categories: Record<Category, ConfigItem[]> = {
    instructions: [],
    agents: [],
    skills: [],
    commands: [],
    settings: [],
  }

  for (const section of sections) {
    const items = flattenItems(section.items, section.scope, section.pluginName)
    for (const item of items) {
      switch (item.fileType) {
        case "claude-md":
          categories.instructions.push(item)
          break
        case "agent":
          categories.agents.push(item)
          break
        case "skill":
          categories.skills.push(item)
          break
        case "command":
          categories.commands.push(item)
          break
        case "settings":
        default:
          categories.settings.push(item)
      }
    }
  }

  return categories
}
