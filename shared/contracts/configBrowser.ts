/**
 * Wire contract for the config browser. The server scans the config roots and
 * the renderer draws the result, so both sides read these shapes from here.
 */
import type { AgentKind } from "../session/types"

export type ConfigFileType =
  | "command"
  | "skill"
  | "agent"
  | "instructions"
  | "settings"
  | "unknown"
  | "theme"
  | "monitor"
  | "bin"

/**
 * Which CLI loads a config entry.
 *
 * Every agent reads its own directories, but a shared setup points several of
 * them at one `.agents` tree via symlinks. The browser scans every location and
 * merges entries that resolve to the same file, so a skill shows up once with
 * the CLIs that can actually load it.
 *
 * This is the agent set and nothing narrower — hardcoding two of the three here
 * is what made GitHub Copilot's configuration unreachable.
 */
export type ConfigCli = AgentKind

export interface ConfigTreeItem {
  name: string
  path: string
  type: "file" | "directory"
  fileType?: ConfigFileType
  description?: string
  children?: ConfigTreeItem[]
  readOnly?: boolean
  /** CLIs that load this entry. Empty means it is linked into neither. */
  cli?: ConfigCli[]
  /** Canonical target when this entry reaches the file through a symlink. */
  linkTarget?: string
}

export interface ConfigTreeSection {
  label: string
  scope: "global" | "project" | "plugin"
  pluginName?: string
  baseDir?: string
  items: ConfigTreeItem[]
}
