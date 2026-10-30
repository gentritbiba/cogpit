import type { GitHubReviewSide } from "@cogpit/plugin-integrations"
import type { JsonValue } from "@cogpit/plugin-contracts"

/**
 * Local pull request review state (item 9): draft inline comments and viewed
 * marks, kept in the plugin's project storage. A draft names the exact
 * repository, pull request, head, path, side and line it was written on; once
 * the pull request has another head it is stale and stays where it was.
 */

export interface PatchRow {
  kind: "hunk" | "add" | "del" | "context"
  text: string
  oldLine: number | null
  newLine: number | null
}

/** A unified diff patch as rows with the line numbers GitHub anchors review comments on. */
export function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = []
  let oldLine = 0, newLine = 0
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2])
      rows.push({ kind: "hunk", text: line, oldLine: null, newLine: null })
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++ })
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null })
    else if (line.startsWith("\\")) continue
    else rows.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
  }
  return rows
}

/** Where a comment on `row` anchors: removed lines on the base side, everything else on the head side. */
export function anchorOf(row: PatchRow): { side: GitHubReviewSide; line: number } | null {
  if (row.kind === "del") return row.oldLine === null ? null : { side: "LEFT", line: row.oldLine }
  if (row.kind === "hunk") return null
  return row.newLine === null ? null : { side: "RIGHT", line: row.newLine }
}

export function sameAnchor(row: PatchRow, anchor: { side: GitHubReviewSide; line: number }): boolean {
  const own = anchorOf(row)
  return own !== null && own.side === anchor.side && own.line === anchor.line
}

/** A few rows around `index`, as the excerpt a fix request carries. */
export function excerptAround(rows: readonly PatchRow[], index: number, radius = 3): string {
  return rows.slice(Math.max(0, index - radius), index + radius + 1)
    .filter((row) => row.kind !== "hunk")
    .map((row) => `${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}${row.text}`)
    .join("\n")
}

export interface PullIdentity { host: string; owner: string; name: string; number: number }

export interface ReviewDraft {
  id: string
  headSha: string
  path: string
  side: GitHubReviewSide
  line: number
  body: string
  /** The diff lines around the anchor when it was written, for fix requests and stale drafts. */
  excerpt: string
  createdAt: string
}

export type SubmissionState = "pending" | "submitted" | "unknown" | "failed" | "stale"
export interface ReviewSubmission {
  id: string
  headSha: string
  body: string
  draftIds: string[]
  state: SubmissionState
  at: string
  url?: string | null
  error?: string
}

export interface ReviewState extends PullIdentity {
  drafts: ReviewDraft[]
  /** Blob SHA prefixes of files marked viewed; a changed file has another blob and shows unviewed. */
  viewed: string[]
  submission: ReviewSubmission | null
}

export const DRAFT_LIMITS = Object.freeze({ drafts: 50, bodyChars: 4000, viewed: 1500 })

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  return Array.from(bytes.slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The storage key of a pull request's review state, unique per host, repository and number. */
export function reviewKey(pull: PullIdentity): Promise<string> {
  return digest(`${pull.host.toLowerCase()}/${pull.owner.toLowerCase()}/${pull.name.toLowerCase()}#${pull.number}`).then((hex) => `review.${hex}`)
}

export function emptyReview(pull: PullIdentity): ReviewState {
  return { ...pull, drafts: [], viewed: [], submission: null }
}

/** The saved state when it belongs to exactly this pull request, else a fresh one. */
export function readReview(value: JsonValue, pull: PullIdentity): ReviewState {
  const saved = value as unknown as Partial<ReviewState> | null
  const matches = saved && typeof saved === "object" && saved.host === pull.host && saved.owner === pull.owner && saved.name === pull.name && saved.number === pull.number
  if (!matches || !Array.isArray(saved.drafts) || !Array.isArray(saved.viewed)) return emptyReview(pull)
  return { ...pull, drafts: saved.drafts, viewed: saved.viewed, submission: saved.submission ?? null }
}

export function viewedMark(blobSha: string | null): string | null {
  return blobSha ? blobSha.slice(0, 12) : null
}

/** `randomUUID` needs a secure context, which a plugin frame is not. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Drafts as Markdown, for copying them anywhere by hand. */
export function draftsMarkdown(pull: PullIdentity, drafts: readonly ReviewDraft[]): string {
  return [`Review notes for ${pull.owner}/${pull.name}#${pull.number}`, "", ...drafts.flatMap((draft) => [
    `- \`${draft.path}\` ${draft.side === "LEFT" ? "base" : "head"} line ${draft.line} (${draft.headSha.slice(0, 7)}):`,
    ...draft.body.split("\n").map((line) => `  ${line}`),
  ])].join("\n")
}
