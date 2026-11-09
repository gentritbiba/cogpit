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
const SUBAGENT_READ_BATCH = 16
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

/** The opening of a member's spawn prompt as a transcript line carries it: raw, or escaped inside JSON. */
function promptForms(member: TeamMemberRef): string[] {
  const snippet = (member.prompt || "").slice(0, 120)
  return snippet ? [snippet, JSON.stringify(snippet).slice(1, -1)] : []
}

function nameForms(name: string): string[] {
  return [name, name.replace(/-/g, " ")]
}

/** Whether `name` occurs in `line` other than as part of one of the `longer` names containing it. */
function occursOnItsOwn(line: string, name: string, longer: readonly string[]): boolean {
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const insideLonger = longer.some((other) => {
      for (let start = Math.max(0, at + name.length - other.length); start <= at; start++) {
        if (line.startsWith(other, start)) return true
      }
      return false
    })
    if (!insideLonger) return true
  }
  return false
}

/**
 * The member a sub-agent transcript's first line names, or null. A spawn
 * prompt is the stronger match; otherwise the first member in config order
 * whose name appears on its own, so "dev-10" in the line does not name "dev-1".
 */
function bestMember(firstLine: string, members: ReadonlyArray<TeamMemberRef>): string | null {
  const eligible = members.filter((member): member is TeamMemberRef & { name: string } =>
    Boolean(member.name) && member.agentType !== "team-lead")
  const byPrompt = eligible.find((member) => promptForms(member).some((form) => firstLine.includes(form)))
  if (byPrompt) return byPrompt.name
  const allForms = eligible.flatMap((member) => nameForms(member.name))
  const byName = eligible.find((member) => nameForms(member.name).some((form) =>
    occursOnItsOwn(firstLine, form, allForms.filter((other) => other.length > form.length && other.includes(form)))))
  return byName?.name ?? null
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
  for (let start = 0; start < names.length; start += SUBAGENT_READ_BATCH) {
    const batch = names.slice(start, start + SUBAGENT_READ_BATCH)
    const firstLines = await Promise.all(batch.map((name) => readSubagentFirstLine(join(subagentDir, name))))
    const match = batch.findIndex((_, i) => firstLines[i] !== null && bestMember(firstLines[i]!, members) === memberName)
    if (match >= 0) return batch[match]
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
