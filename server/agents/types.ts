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
}
