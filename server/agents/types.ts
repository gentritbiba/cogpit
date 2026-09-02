import type { AgentDescriptor, AgentKind } from "../../shared/session/agent-descriptors"

/** One transcript found by walking an agent's storage root. */
export interface SessionFileInfo {
  /** Absolute path of the transcript on disk. */
  filePath: string
  /**
   * The `fileName` half of the `{dirName, fileName}` pair the UI addresses this
   * session by, always forward-slashed so it survives a URL round trip.
   * Feeding it back to `resolveSessionFile` returns `filePath`.
   */
  fileName: string
  /**
   * The `dirName` half, when the agent encodes the project in the path itself.
   *
   * Null for agents that record the project only inside the transcript: their
   * dirName is derived from a recorded `cwd`, which costs an identity read the
   * listing deliberately does not pay.
   */
  dirName: string | null
  mtimeMs: number
  size: number
}

/** Cheap identity from a transcript's head, for placing it in the inventory. */
export interface SessionIdentity {
  sessionId: string
  cwd: string
  gitBranch: string
  isSubagent: boolean
  parentSessionId: string | null
}

/** The opening lines of a transcript, as `readTranscriptHead` reads them. */
export interface TranscriptHead {
  lines: string[]
  /** True when only the head was read; `lines` then stops short of the end. */
  isPartialRead: boolean
  /** Whole-file size in bytes. */
  size: number
}

/** Everything the session lists, headers and notifications read from a transcript. */
export interface SessionMeta {
  sessionId: string
  version: string
  gitBranch: string
  model: string
  slug: string
  name: string
  aiTitle: string
  customTitle: string
  cwd: string
  firstUserMessage: string
  lastUserMessage: string
  timestamp: string
  lastTimestamp: string
  turnCount: number
  lineCount: number
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
  /** Agent-team identity, when the session is a teammate. */
  teamName: string
  agentName: string
  /** Worktree checkout the session is operating in, when it entered one. */
  worktreeName?: string
  worktreeBranch?: string
  originalBranch?: string
  /** The agent type the session was launched as, e.g. "general-purpose". */
  agentSetting?: string
  isSubagent: boolean
  parentSessionId: string | null
  /** Canonical collaboration path of the agent owning this transcript, where the CLI records one. */
  agentPath?: string
}

/** One project with sessions in an agent's storage. */
export interface AgentProjectEntry {
  dirName: string
  path: string
  sessionCount: number
  lastModified: string | null
}

/** A transcript listed under one project. */
export interface ProjectSessionFileInfo extends SessionFileInfo {
  dirName: string
  /** Known up front where the listing had to read it; derived from the name otherwise. */
  sessionId?: string
}

/** A top-level session, with the dirName the UI addresses it by. */
export interface TopLevelSessionInfo extends SessionFileInfo {
  dirName: string
  /** The recorded cwd, where the dirName was derived from it. */
  projectPath?: string
  sessionId?: string
}

/** A sub-agent transcript written beside its parent session. */
export interface SubagentFileInfo {
  agentId: string
  /** Relative transcript path, where it cannot be rebuilt from the parent and agent ids. */
  fileName?: string
  size: number
  modifiedAt: number
}

/** The `{dirName, fileName}` pair the UI addresses a transcript by. */
export interface SessionAddress {
  dirName: string
  fileName: string
}

/**
 * On-disk session storage for one agent CLI.
 *
 * The three CLIs store transcripts in completely different shapes — Claude
 * writes `<projects>/<encoded-cwd>/<uuid>.jsonl`, Codex nests dated rollouts,
 * Copilot keeps `<uuid>/events.jsonl` — and this is the interface that stops
 * that from leaking into routes. Anything here needs `node:fs`, which is why
 * stores live in `server/` while the pure `AgentDescriptor` lives in `shared/`.
 */
export interface AgentStore {
  readonly kind: AgentKind
  readonly descriptor: AgentDescriptor
  /** Absolute root of this agent's session storage, or null when unconfigured. */
  sessionsRoot(): string | null
  /** True when an absolute path lives inside this agent's storage. */
  ownsPath(filePath: string): boolean
  /** Every transcript under the root, stat-only — no file contents are read. */
  listSessionFiles(): Promise<SessionFileInfo[]>
  /** Untrusted `{dirName, fileName}` to a safe absolute path, or null. */
  resolveSessionFile(dirName: string, fileName: string): Promise<string | null>
  /** Locate a session by id within this agent's storage. */
  findSessionFile(sessionId: string): Promise<string | null>
  /** Cheap head-read identity, or null when this agent has no such fast path. */
  readIdentity(filePath: string): Promise<SessionIdentity | null>
  /** Full metadata, given the transcript head the caller already read. */
  readSessionMeta(filePath: string, head: TranscriptHead): Promise<SessionMeta>
  /** Projects with sessions in this storage. */
  listProjects(): Promise<AgentProjectEntry[]>
  /**
   * Top-level sessions of one project, or null when `dirName` cannot address
   * one. Stat-level where the path names the project, an identity read where
   * only the transcript does.
   */
  listProjectSessionFiles(dirName: string): Promise<ProjectSessionFileInfo[] | null>
  /** Every top-level session, with the dirName the UI addresses it by. */
  listTopLevelSessions(): Promise<TopLevelSessionInfo[]>
  /**
   * Sub-agent transcripts of a session, for an agent that writes them as
   * files; null when the address is refused.
   */
  listSubagentFiles(dirName: string, sessionId: string): Promise<SubagentFileInfo[] | null>
  /** How the UI addresses the transcript at `filePath`, or null when it cannot. */
  sessionAddress(filePath: string): Promise<SessionAddress | null>
  /**
   * Where a new transcript for `sessionId` under `dirName` would be written,
   * without checking anything exists, and the root-relative name the UI
   * addresses it by; null when this agent has no storage. Computed together
   * because a date-stamped name read twice can differ.
   */
  transcriptPath(dirName: string, sessionId: string): { filePath: string; fileName: string } | null
}
