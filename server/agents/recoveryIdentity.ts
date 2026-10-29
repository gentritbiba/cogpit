import { createHash } from "node:crypto"
import { createInterface } from "node:readline"
import { stat } from "node:fs/promises"
import { transcriptReadStream } from "./transcriptFile"
import { isRecord } from "../../shared/objects"
import { createCodexPromptReader } from "../../shared/session/codex"
import { userMessageTextFromLine } from "./recordReaders"
import { formatFor } from "../../shared/session/agents"
import type { AgentKind } from "../../shared/session/agent-descriptors"

// An open prompt keeps a trailing tool result from synthesizing a turn.
const seedPrompts: Record<AgentKind, Record<string, unknown>[]> = {
  claude: [{ type: "user", message: { role: "user", content: "Recovery identity seed" } }],
  acp: [{ type: "user", message: { role: "user", content: "Recovery identity seed" } }],
  codex: [],
  copilot: [],
}
const identities = new Map<string, { stamp: string; promise: Promise<string> }>()

/** A fingerprint of native user turns, including image-only prompts and undo. */
export async function recoveryIdentity(filePath: string, kind: AgentKind): Promise<string> {
  const file = await stat(filePath)
  const stamp = `${kind}:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`
  const cached = identities.get(filePath)
  if (cached?.stamp === stamp) return cached.promise
  const promise = fingerprint(filePath, kind)
  identities.set(filePath, { stamp, promise })
  if (identities.size > 32) identities.delete(identities.keys().next().value!)
  try { return await promise } catch (error) { if (identities.get(filePath)?.promise === promise) identities.delete(filePath); throw error }
}

async function fingerprint(filePath: string, kind: AgentKind): Promise<string> {
  const hash = createHash("sha256")
  const input = transcriptReadStream(filePath)
  const lines = createInterface({ input, crlfDelay: Infinity })
  const format = formatFor(kind)
  const readPrompt = kind === "codex" ? createCodexPromptReader() : null
  let responseEchoPending = false
  try {
    for await (const line of lines) {
      let record: unknown
      try { record = JSON.parse(line) } catch { continue }
      if (!isRecord(record)) continue
      if (readPrompt) {
        const prompt = readPrompt(record)
        const payload = isRecord(record.payload) ? record.payload : null
        if (record.type === "response_item") {
          responseEchoPending = false
          if (payload?.type !== "message" || payload.role !== "user" || !format.turnBoundaries([record]).includes(0)) continue
          responseEchoPending = true
        } else if (record.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") {
          const echo = responseEchoPending
          responseEchoPending = false
          if (echo) continue
          if (!prompt) {
            if (payload.message.trim()) continue
            const content = format.parse(line).turns[0]?.userMessage
            if (typeof content === "string" ? !content.trim() : !content?.length) continue
          }
        } else continue
      } else if (userMessageTextFromLine(line) === null) continue
      if (format.turnBoundaries([...seedPrompts[kind], record]).includes(seedPrompts[kind].length)) hash.update(line).update("\n")
    }
    return hash.digest("hex")
  } finally { lines.close(); input.destroy() }
}
