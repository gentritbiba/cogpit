/**
 * Wire contract for the config browser. The server scans the config roots and
 * the renderer draws the result, so both sides read these shapes from here.
 */

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
 * Claude Code and Codex CLI read separate directories, but a shared setup
 * points both at one `.agents` tree via symlinks. The browser scans every
 * location and merges entries that resolve to the same file, so a skill shows
 * up once with the CLIs that can actually load it.
 */
export type ConfigCli = "claude" | "codex"

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
