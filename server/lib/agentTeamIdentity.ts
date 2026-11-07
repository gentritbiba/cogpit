import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { dirs } from "../dirs"

/**
 * Who wrote a transcript, when the writer was a member of an agent team.
 *
 * Both answers come from the head of a JSONL file rather than any index,
 * because a team's own configuration does not record its members' session
 * ids — the tags on the transcript lines are the only link back.
 */

export interface TeamTags {
  teamName: string | null
  agentName: string | null
}

export interface TeamMemberRef {
  name?: string
  agentType?: string
  prompt?: string
}

/** A sub-agent transcript as its lead's `subagents/` directory names it; nothing that leaves the directory. */
const SUBAGENT_FILE_NAME = /^agent-[^/\\]+\.jsonl$/

const SUBAGENT_HEAD_BYTES = 16384
const TAG_HEAD_BYTES = 32768
const TAG_HEAD_LINES = 40
const NO_TAGS: TeamTags = Object.freeze({ teamName: null, agentName: null })

async function readHead(filePath: string, bytes: number): Promise<{ text: string; full: boolean }> {
  const fh = await open(filePath, "r")
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return { text: buf.subarray(0, bytesRead).toString("utf-8"), full: bytesRead === bytes }
  } finally {
    await fh.close()
  }
}

function firstLineOf(text: string): string {
  return text.split("\n")[0] || ""
}

/**
 * How strongly a sub-agent's first line names a member: its spawn prompt beats
 * its name, and a longer name beats one it contains ("dev-10" over "dev-1").
 */
function memberScore(firstLine: string, member: TeamMemberRef): number {
  if (!member.name || member.agentType === "team-lead") return 0
  const snippet = (member.prompt || "").slice(0, 120)
  if (snippet && (firstLine.includes(snippet) || firstLine.includes(snippet.replace(/"/g, '\\"')))) {
    return 1_000_000 + snippet.length
  }
  if (firstLine.includes(member.name) || firstLine.includes(member.name.replace(/-/g, " "))) {
    return member.name.length
  }
  return 0
}

/** The member a sub-agent transcript's first line names best, or null. */
function bestMember(firstLine: string, members: ReadonlyArray<TeamMemberRef>): string | null {
  let best: string | null = null
  let bestScore = 0
  for (const member of members) {
    const score = memberScore(firstLine, member)
    if (score > bestScore) {
      best = member.name ?? null
      bestScore = score
    }
  }
  return best
}

async function readSubagentFirstLine(filePath: string): Promise<string | null> {
  try {
    return firstLineOf((await readHead(filePath, SUBAGENT_HEAD_BYTES)).text)
  } catch {
    return null
  }
}

/** The member a legacy sub-agent transcript belongs to, matched by the lead's spawn prompt. */
export async function matchSubagentToMember(
  leadSessionId: string,
  subagentFileName: string,
  members: ReadonlyArray<TeamMemberRef>
): Promise<string | null> {
  if (!SUBAGENT_FILE_NAME.test(subagentFileName)) return null
  const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "memory") continue
    const firstLine = await readSubagentFirstLine(
      join(dirs.PROJECTS_DIR, entry.name, leadSessionId, "subagents", subagentFileName)
    )
    if (firstLine !== null) return bestMember(firstLine, members)
  }
  return null
}

/**
 * The file in a legacy lead's `subagents/` directory that belongs to
 * `memberName`: the one whose first line names that member best.
 */
export async function findSubagentOfMember(
  subagentDir: string,
  memberName: string,
  members: ReadonlyArray<TeamMemberRef>
): Promise<string | null> {
  let names: string[]
  try {
    names = (await readdir(subagentDir)).filter((name) => SUBAGENT_FILE_NAME.test(name))
  } catch {
    return null
  }
  const firstLines = await Promise.all(names.map((name) => readSubagentFirstLine(join(subagentDir, name))))
  for (let i = 0; i < names.length; i++) {
    const firstLine = firstLines[i]
    if (firstLine !== null && bestMember(firstLine, members) === memberName) return names[i]
  }
  return null
}

interface TagMemoEntry {
  size: number
  mtimeMs: number
  tags: TeamTags
  /** The head the tags came from can no longer change: a tag was found, or the head was already complete. */
  settled: boolean
}

const TAG_MEMO_LIMIT = 20_000
const tagMemo = new Map<string, TagMemoEntry>()

function rememberTags(filePath: string, entry: TagMemoEntry): void {
  tagMemo.delete(filePath)
  tagMemo.set(filePath, entry)
  if (tagMemo.size > TAG_MEMO_LIMIT) tagMemo.delete(tagMemo.keys().next().value!)
}

async function readTagsFromHead(filePath: string): Promise<{ tags: TeamTags; settled: boolean }> {
  const { text, full } = await readHead(filePath, TAG_HEAD_BYTES)
  const lines = text.split("\n")
  // The last line may still be being written, or cut off by the read
  const scanned = (full ? lines.slice(0, -1) : lines).slice(0, TAG_HEAD_LINES)
  for (const line of scanned) {
    if (!line.includes('"teamName"')) continue
    try {
      const obj = JSON.parse(line)
      if (typeof obj.teamName === "string" && obj.teamName) {
        return {
          tags: { teamName: obj.teamName, agentName: typeof obj.agentName === "string" && obj.agentName ? obj.agentName : null },
          settled: true,
        }
      }
    } catch { /* skip malformed */ }
  }
  return { tags: NO_TAGS, settled: full || lines.length > TAG_HEAD_LINES }
}

/**
 * Read a session's agent-team identity from the head of its JSONL file.
 * Claude Code 2.1.19x+ runs team members as their own top-level sessions
 * whose message lines carry `teamName` and `agentName` fields.
 *
 * Transcripts only grow, so once the head is settled the answer is kept for
 * as long as the file does not shrink. Pass `known` stats from a listing to
 * skip the stat.
 */
export async function readSessionTeamTags(
  filePath: string,
  known?: { mtimeMs: number; size: number }
): Promise<TeamTags> {
  const stats = known ?? await stat(filePath).catch(() => null)
  if (!stats) {
    tagMemo.delete(filePath)
    return NO_TAGS
  }
  const cached = tagMemo.get(filePath)
  if (cached && (cached.settled
    ? stats.size >= cached.size
    : stats.size === cached.size && stats.mtimeMs === cached.mtimeMs)) {
    return cached.tags
  }
  try {
    const { tags, settled } = await readTagsFromHead(filePath)
    rememberTags(filePath, { size: stats.size, mtimeMs: stats.mtimeMs, tags, settled })
    return tags
  } catch {
    tagMemo.delete(filePath)
    return NO_TAGS
  }
}
