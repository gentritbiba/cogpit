import type { ConfigFileType } from "./configValidation"

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

export interface CliSourceDir {
  dir: string
  /** CLIs loading this directory. Empty means a shared source no CLI reads directly. */
  cli: ConfigCli[]
}

export interface CliSourceFile {
  path: string
  name: string
  cli: ConfigCli[]
}

export interface ConfigScopeLayout {
  /** Directory new files are created in, and the anchor for the section. */
  baseDir: string
  instructions: CliSourceFile[]
  settings: CliSourceFile[]
  skills: CliSourceDir[]
  agents: CliSourceDir[]
  commands: CliSourceDir[]
  themesDir?: string
}
