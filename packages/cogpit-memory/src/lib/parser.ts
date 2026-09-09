// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Transcript entry point: pick the format a transcript was written in, then let
 * it do the work. Every grammar lives in its own module behind `AgentFormat`;
 * this file only routes and holds the small presentation helpers that operate
 * on the already-parsed model.
 */
import { TERMINAL_AGENT_KIND, formatForRecords, formatForText } from "./agents"
import type {
  ContentBlock,
  ImageBlock,
  ParseSessionOptions,
  ParsedSession,
  UserContent,
} from "./types"

export type { PendingInteraction } from "./interactiveState"
export type { ParseSessionOptions } from "./types"
export { detectPendingInteraction } from "./interactiveState"

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
}

// ── Public API ──────────────────────────────────────────────────────────────

export function parseSession(jsonlText: string, options?: ParseSessionOptions): ParsedSession {
  return formatForText(jsonlText).parse(jsonlText, options)
}

/**
 * Incrementally append new JSONL lines to an existing parsed session.
 *
 * Dispatch is on raw-record shape, never on `existing.agentKind`: that field is
 * optional on `ParsedSession` and this is the append hot path. When the records
 * carry no discriminator — an empty window, or one paged in above the loaded
 * range — the newly arrived text decides instead.
 */
export function parseSessionAppend(
  existing: ParsedSession,
  newJsonlText: string
): ParsedSession {
  const byRecords = formatForRecords(existing.rawMessages)
  const format = byRecords.kind === TERMINAL_AGENT_KIND ? formatForText(newJsonlText) : byRecords
  return format.append(existing, newJsonlText)
}

export function getUserMessageText(content: UserContent | null): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return extractTextFromContent(content)
}

export function getUserMessageImages(content: UserContent | null): ImageBlock[] {
  if (content === null || typeof content === "string") return []
  return content.filter((b): b is ImageBlock => b.type === "image")
}
