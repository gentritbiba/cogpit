// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * The agent-format registry: one table row per CLI, and the resolvers that pick
 * a row from a transcript.
 *
 * `AgentFormat` is the pure transcript grammar — detection, parsing,
 * incremental append, header metadata and status derivation. Anything needing
 * `node:fs` is an `AgentStore` and lives in `server/agents/`, because `shared/`
 * is bundled into the renderer and must stay free of node builtins.
 *
 * **Import direction is load-bearing.** The three format modules must never
 * import this one, not even `import type`: `scripts/check-architecture.ts`
 * counts a type-only import as a real graph edge and runs a Tarjan cycle check,
 * so a single back-edge fails the build. The legal shape is
 * `types → agent-descriptors → {formats} → agents → {parser, sessionStatus, …}`.
 *
 * Detection precedence is `AGENT_KINDS` order and nothing else. The last kind
 * in that list is the terminal arm: its detectors answer `true` unconditionally,
 * so a transcript reaches it only after every positively-discriminated format
 * has declined. No format needs to know its siblings exist.
 */
import { descriptorFor } from "./agent-descriptors"
import {
  appendClaudeSession,
  brandClaudeBranch,
  claudeTurnBoundaries,
  deriveClaudeSessionStatus,
  extractClaudeMetadataFromLines,
  isClaudeSessionText,
  parseClaudeSession,
} from "./claude"
import {
  appendCodexSession,
  brandCodexBranch,
  codexTurnBoundaries,
  deriveCodexSessionStatus,
  extractCodexMetadataFromLines,
  isCodexRawRecords,
  isCodexSessionText,
  parseCodexSession,
} from "./codex"
import {
  appendCopilotSession,
  brandCopilotBranch,
  copilotTurnBoundaries,
  deriveCopilotSessionStatus,
  extractCopilotMetadataFromLines,
  isCopilotRawRecords,
  isCopilotSessionText,
  parseCopilotSession,
} from "./copilot"
import { AGENT_KINDS, type AgentKind } from "./types"
import type {
  ParseSessionOptions,
  ParsedSession,
  RawRecord,
  SessionStatusInfo,
} from "./types"
import type { AgentDescriptor } from "./agent-descriptors"

export type {
  AgentCapabilities,
  AgentDescriptor,
  AgentDirNameCodec,
  AgentKind,
  AgentSessionFileCodec,
} from "./agent-descriptors"
export {
  AGENT_KINDS,
  CODEX_DIR_PREFIX,
  COPILOT_DIR_PREFIX,
  agentKindForDirName,
  allDescriptors,
  descriptorFor,
  descriptorForDirName,
  isSessionUuid,
  projectDirNameFor,
  sessionIdFromFileName,
} from "./agent-descriptors"

// ── The interface ───────────────────────────────────────────────────────────

/**
 * Header metadata every format can report from the first lines of a transcript.
 *
 * Individual formats return supersets of this (turn counts, first/last user
 * message, sub-agent parentage); the registry narrows them to the fields all
 * three agree on.
 */
export interface AgentSessionMetadata {
  sessionId: string
  version: string
  gitBranch: string
  cwd: string
  slug: string
  name: string
  model: string
  branchedFrom?: { sessionId: string; turnIndex?: number | null }
}

export interface AgentFormat {
  readonly kind: AgentKind
  readonly descriptor: AgentDescriptor
  /** True when this JSONL text was produced by this CLI. */
  detectsText(jsonlText: string): boolean
  /** True when these already-parsed raw records came from this CLI. */
  detectsRecords(records: readonly { type?: unknown }[]): boolean
  /** Full parse into the shared session model. */
  parse(jsonlText: string, options?: ParseSessionOptions): ParsedSession
  /** Incremental append of newly written lines. */
  append(existing: ParsedSession, newJsonlText: string): ParsedSession
  /** Cheap header metadata read from already-split transcript lines. */
  metadataFromLines(lines: readonly string[]): AgentSessionMetadata
  /** Status derived from raw records. */
  status(records: readonly RawRecord[]): SessionStatusInfo
  /**
   * The first record of a transcript, rewritten for a branch: it now names
   * `sessionId` and records the session and turn it was cut from. Returns the
   * id the record carried before, which is what the branch reports as its
   * origin.
   */
  brandBranch(
    firstRecord: Record<string, unknown>,
    sessionId: string,
    turnIndex: number | null,
  ): { record: Record<string, unknown>; originalId: string }
  /**
   * Indexes of the records at which a turn starts, in file order.
   *
   * The **one** implementation of turn-boundary detection. Undo cuts a
   * transcript by computing `keepLines` on the client and having the server
   * verify and apply it; if the two sides scanned for boundaries separately
   * and ever disagreed by one line, the result would be a silently corrupted
   * transcript rather than an error. They cannot disagree while they both call
   * this.
   */
  turnBoundaries(records: readonly Record<string, unknown>[]): number[]
}

/**
 * The kind that claims any transcript nothing else did. Detection order makes
 * it the last entry of `AGENT_KINDS`; callers that need to know whether
 * detection actually matched compare against this.
 */
export const TERMINAL_AGENT_KIND: AgentKind = AGENT_KINDS[AGENT_KINDS.length - 1]

// ── The table ───────────────────────────────────────────────────────────────

const codexFormat: AgentFormat = {
  kind: "codex",
  descriptor: descriptorFor("codex"),
  detectsText: isCodexSessionText,
  detectsRecords: isCodexRawRecords,
  parse: parseCodexSession,
  append: appendCodexSession,
  metadataFromLines: extractCodexMetadataFromLines,
  status: deriveCodexSessionStatus,
  brandBranch: brandCodexBranch,
  turnBoundaries: codexTurnBoundaries,
}

const copilotFormat: AgentFormat = {
  kind: "copilot",
  descriptor: descriptorFor("copilot"),
  detectsText: isCopilotSessionText,
  detectsRecords: isCopilotRawRecords,
  parse: parseCopilotSession,
  append: appendCopilotSession,
  metadataFromLines: extractCopilotMetadataFromLines,
  status: deriveCopilotSessionStatus,
  brandBranch: brandCopilotBranch,
  turnBoundaries: copilotTurnBoundaries,
}

const claudeFormat: AgentFormat = {
  kind: "claude",
  descriptor: descriptorFor("claude"),
  // The terminal arm answers `true` for both, so order alone decides.
  detectsText: isClaudeSessionText,
  detectsRecords: isClaudeSessionText,
  parse: parseClaudeSession,
  append: appendClaudeSession,
  metadataFromLines: extractClaudeMetadataFromLines,
  status: deriveClaudeSessionStatus,
  brandBranch: brandClaudeBranch,
  turnBoundaries: claudeTurnBoundaries,
}

const FORMATS: Readonly<Record<AgentKind, AgentFormat>> = Object.freeze({
  claude: claudeFormat,
  codex: codexFormat,
  copilot: copilotFormat,
})

// ── Resolvers ───────────────────────────────────────────────────────────────

export interface FormatRegistry {
  formatFor(kind: AgentKind): AgentFormat
  formatForText(jsonlText: string): AgentFormat
  formatForRecords(records: readonly { type?: unknown }[]): AgentFormat
}

/**
 * Build resolvers over an arbitrary format table. The module-level singletons
 * below are this applied to the real table; tests inject a fake one.
 */
export function createFormatRegistry(
  formats: Readonly<Record<AgentKind, AgentFormat>>,
): FormatRegistry {
  function firstMatch(matches: (format: AgentFormat) => boolean): AgentFormat {
    for (const kind of AGENT_KINDS) {
      const format = formats[kind]
      if (matches(format)) return format
    }
    // Only reachable from an injected table whose terminal format declines.
    return formats[TERMINAL_AGENT_KIND]
  }

  return {
    formatFor: (kind) => formats[kind],
    formatForText: (jsonlText) => firstMatch((format) => format.detectsText(jsonlText)),
    formatForRecords: (records) => firstMatch((format) => format.detectsRecords(records)),
  }
}

const registry = createFormatRegistry(FORMATS)

export function formatFor(kind: AgentKind): AgentFormat {
  return registry.formatFor(kind)
}

export function formatForText(jsonlText: string): AgentFormat {
  return registry.formatForText(jsonlText)
}

export function formatForRecords(records: readonly { type?: unknown }[]): AgentFormat {
  return registry.formatForRecords(records)
}

// ── Turn-boundary cut points ────────────────────────────────────────────────

/**
 * Boundary indexes for raw JSONL lines rather than parsed records.
 *
 * A malformed line stands in as an empty record so indexes keep matching the
 * caller's line array — every consumer here slices that array by the returned
 * index, so dropping a line would shift the cut.
 */
export function turnBoundaryLines(
  format: AgentFormat,
  lines: readonly string[],
): number[] {
  const records = lines.map((line) => {
    try {
      const parsed: unknown = JSON.parse(line)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  })
  return format.turnBoundaries(records)
}

/**
 * The line to cut at to keep exactly `keepTurnCount` turns — i.e. where the
 * turn after the last kept one begins. `lines.length` when the transcript has
 * no more turns than that, meaning nothing is removed.
 */
export function cutLineForTurnCount(
  format: AgentFormat,
  lines: readonly string[],
  keepTurnCount: number,
): number {
  return turnBoundaryLines(format, lines)[keepTurnCount] ?? lines.length
}

/**
 * The line to cut at to keep everything through turn `turnIndex`, or null when
 * that turn is the last one and there is nothing to remove.
 */
export function cutLineAfterTurnIndex(
  format: AgentFormat,
  lines: readonly string[],
  turnIndex: number,
): number | null {
  return turnBoundaryLines(format, lines)[turnIndex + 1] ?? null
}

/**
 * The line to cut at to keep everything through the turn containing the record
 * whose `uuid` is `turnUuid`. Correct even when the caller has only a tail of
 * the transcript loaded, so its turn indexes do not match file order.
 *
 * `"keep-all"` means the uuid was found in the last turn (nothing to remove);
 * null means it was not found at all, and the caller should fall back to an
 * index-based cut.
 */
export function cutLineAfterUuid(
  format: AgentFormat,
  lines: readonly string[],
  turnUuid: string,
): number | "keep-all" | null {
  let targetLine = -1
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(turnUuid)) continue
    try {
      const parsed = JSON.parse(lines[index]) as Record<string, unknown>
      if (parsed?.uuid === turnUuid) {
        targetLine = index
        break
      }
    } catch {
      // A malformed line carries no uuid to match.
    }
  }
  if (targetLine < 0) return null
  return turnBoundaryLines(format, lines).find((line) => line > targetLine) ?? "keep-all"
}
