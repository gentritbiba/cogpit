import { BookOpen, Bot, Sparkles, Terminal, FileJson } from "lucide-react"
import type { ConfigCli, ConfigTreeItem, ConfigTreeSection } from "../../../shared/contracts/configBrowser"

// ── Types ──────────────────────────────────────────────────────────────

export type { ConfigCli, ConfigTreeSection }

/** A flattened config item for the category view and editor selection */
export interface ConfigItem {
  name: string
  path: string
  fileType: string
  description: string
  scope: "global" | "project" | "plugin" | string
  pluginName?: string
  readOnly: boolean
  /** CLIs that load this entry. Empty means it is linked into neither. */
  cli?: ConfigCli[]
  /** Canonical target when this entry reaches the file through a symlink. */
  linkTarget?: string
}

export type Category = "instructions" | "agents" | "skills" | "commands" | "settings"

// ── Constants ──────────────────────────────────────────────────────────

export const BADGE_COLORS: Record<string, string> = {
  agent: "bg-muted text-muted-foreground",
  skill: "bg-muted text-muted-foreground",
  command: "bg-muted text-muted-foreground",
  instructions: "bg-muted text-muted-foreground",
  settings: "bg-muted text-muted-foreground",
}

export const CATEGORY_DIR_MAP: Record<string, { subdir: string; fileType: "command" | "skill" | "agent" }> = {
  agents: { subdir: "agents", fileType: "agent" },
  skills: { subdir: "skills", fileType: "skill" },
  commands: { subdir: "commands", fileType: "command" },
}

export const CATEGORY_ORDER: Category[] = ["instructions", "agents", "skills", "commands", "settings"]

export const CATEGORY_META: Record<Category, { label: string; icon: typeof BookOpen; color: string }> = {
  instructions: { label: "Instructions", icon: BookOpen, color: "text-muted-foreground" },
  agents: { label: "Agents", icon: Bot, color: "text-muted-foreground" },
  skills: { label: "Skills", icon: Sparkles, color: "text-muted-foreground" },
  commands: { label: "Commands", icon: Terminal, color: "text-muted-foreground" },
  settings: { label: "Settings", icon: FileJson, color: "text-muted-foreground" },
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
        cli: item.cli,
        linkTarget: item.linkTarget,
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
        case "instructions":
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
