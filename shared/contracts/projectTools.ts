/**
 * Wire contracts for the project-tooling routes — script discovery, slash
 * suggestions, the file tree, git status, and MCP servers. Browser-safe.
 */

export interface ScriptEntry {
  name: string
  command: string
  dir: string
  dirLabel: string
  isCommon: boolean
}

export interface SlashSuggestion {
  name: string
  description: string
  type: "command" | "skill"
  source: "project" | "user" | string // plugin name for skills
  filePath: string
}

export interface ProjectTreeEntry {
  /** Basename, or a `a/b/c` chain when the server collapsed single-child directories. */
  name: string
  type: "file" | "directory"
}

export interface GitStatusFile {
  path: string
  originalPath?: string
  indexStatus: string
  workTreeStatus: string
}

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}
