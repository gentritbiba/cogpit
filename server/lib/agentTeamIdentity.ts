import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { dirs } from "../dirs"

/**
 * Who wrote a transcript, when the writer was a member of an agent team.
 *
 * Both answers come from the head of a JSONL file rather than any index,
 * because a team's own configuration does not record its members' session
 * ids — the tags on the transcript lines are the only link back.
 */

export async function matchSubagentToMember(
  leadSessionId: string,
  subagentFileName: string,
  members: Array<{ name: string; agentType: string; prompt?: string }>
): Promise<string | null> {
  const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "memory") continue
    const filePath = join(
      dirs.PROJECTS_DIR,
      entry.name,
      leadSessionId,
      "subagents",
      subagentFileName
    )

    try {
      const fh = await open(filePath, "r")
      try {
        const buf = Buffer.alloc(16384)
        const { bytesRead } = await fh.read(buf, 0, 16384, 0)
        const firstLine =
          buf
            .subarray(0, bytesRead)
            .toString("utf-8")
            .split("\n")[0] || ""

        for (const member of members) {
          if (member.agentType === "team-lead") continue
          const prompt = member.prompt || ""
          const snippet = prompt.slice(0, 120)
          const terms = [
            member.name,
            member.name.replace(/-/g, " "),
            ...(snippet
              ? [snippet, snippet.replace(/"/g, '\\"')]
              : []),
          ]
          if (terms.some((t) => firstLine.includes(t))) {
            return member.name
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Read a session's agent-team identity from the head of its JSONL file.
 * Claude Code 2.1.19x+ runs team members as their own top-level sessions
 * whose message lines carry `teamName` and `agentName` fields.
 */
export async function readSessionTeamTags(
  filePath: string
): Promise<{ teamName: string | null; agentName: string | null }> {
  try {
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(32768)
      const { bytesRead } = await fh.read(buf, 0, 32768, 0)
      const text = buf.subarray(0, bytesRead).toString("utf-8")
      const lines = text.split("\n")
      // The last line may be cut off mid-JSON when the file is larger than the read
      const complete = bytesRead === 32768 ? lines.slice(0, -1) : lines
      for (const line of complete.slice(0, 40)) {
        if (!line || !line.includes('"teamName"')) continue
        try {
          const obj = JSON.parse(line)
          if (typeof obj.teamName === "string" && obj.teamName) {
            return {
              teamName: obj.teamName,
              agentName: typeof obj.agentName === "string" && obj.agentName ? obj.agentName : null,
            }
          }
        } catch { /* skip malformed */ }
      }
      return { teamName: null, agentName: null }
    } finally {
      await fh.close()
    }
  } catch {
    return { teamName: null, agentName: null }
  }
}
