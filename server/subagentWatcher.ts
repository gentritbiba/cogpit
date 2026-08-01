import { readdir, stat, open, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { watch } from "node:fs"
import { randomUUID } from "node:crypto"
import { recordActivity } from "./lib/activityMonitor"

const READ_CHUNK_BYTES = 256 * 1024

/** Weak head-comparison length, used only when it singles out one candidate. */
const PROMPT_HEAD_CHARS = 100

// ── Subagent JSONL watcher ───────────────────────────────────────────
// Claude Code doesn't reliably write agent_progress to the parent JSONL
// when using --output-format stream-json.  The subagent data IS written to
// separate files under <sessionId>/subagents/agent-<id>.jsonl.  This watcher
// monitors those files and synthesizes agent_progress entries into the parent
// JSONL so the SSE file watcher can stream them to the UI.
//
// NOTE: As of Claude Code v2.1.63+, the final subagent result is delivered as
// `toolUseResult` on the tool_result message (see AgentToolUseResult in types.ts).
// This watcher is still needed for LIVE progress during execution — the
// toolUseResult only appears when the subagent finishes.

export interface SubagentWatcher {
  close(): void
}

/**
 * Watch for subagent JSONL files and forward their content as agent_progress
 * entries into the parent session JSONL.
 *
 * @param parentJsonlPath  Path to the parent session's JSONL file
 * @param sessionId        The parent session UUID
 * @param pendingTaskCalls Map of tool_use_id -> prompt for Task tool calls.
 *                         Owned by the caller, which only ever adds to it, so it
 *                         accumulates every Task call of the session — entries
 *                         from earlier turns remain candidates here.
 */
export function watchSubagents(
  parentJsonlPath: string,
  sessionId: string,
  pendingTaskCalls: Map<string, string>,
): SubagentWatcher {
  const subagentsDir = parentJsonlPath.replace(/\.jsonl$/, "") + "/subagents"

  // Track offsets per subagent file and their parentToolUseID mapping
  const fileOffsets = new Map<string, number>()
  const agentToParentToolId = new Map<string, string>()
  // A Task tool_use id belongs to exactly one subagent. Without this, siblings
  // launched in the same batch — whose prompts share a long preamble — all bind
  // to the first Task call and then replay each other's output under every card.
  // A binding proved by the prompt itself is final; one inferred from the weak
  // head comparison is provisional and yields to a later proven match, so a bad
  // guess cannot starve the rightful owner.
  const claims = new Map<string, { agentId: string; proven: boolean }>()
  let closed = false

  /** Resolve the Task call that launched a subagent from its opening message. */
  function resolveParentToolId(promptText: string): { toolId: string; proven: boolean } | undefined {
    const withPrompt = [...pendingTaskCalls].filter(([, prompt]) => prompt.length > 0)
    const provable = withPrompt.filter(([toolId]) => !claims.get(toolId)?.proven)

    // Two byte-identical prompts leave no signal to tell their agents apart;
    // claiming makes the choice arbitrary but at least one-to-one.
    const exact = provable.find(([, prompt]) => prompt === promptText)
    if (exact) return { toolId: exact[0], proven: true }

    // Claude Code may append to the prompt it hands the subagent. The longest
    // matching prompt is the most specific one.
    const prefixed = provable
      .filter(([, prompt]) => promptText.startsWith(prompt))
      .sort((a, b) => b[1].length - a[1].length)
    if (prefixed.length > 0) return { toolId: prefixed[0][0], proven: true }

    // Last resort. Ambiguity here is exactly what made siblings collide, so
    // refuse to guess unless a single unclaimed candidate matches.
    const head = withPrompt
      .filter(([toolId]) => !claims.has(toolId))
      .filter(([, prompt]) => promptText.startsWith(prompt.slice(0, PROMPT_HEAD_CHARS)))
    return head.length === 1 ? { toolId: head[0][0], proven: false } : undefined
  }
  let dirWatcher: ReturnType<typeof watch> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let scanInFlight: Promise<void> | null = null
  let scanRequested = false

  async function forwardLine(line: string, agentId: string): Promise<boolean> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A newline-terminated malformed record cannot become valid later.
      return true
    }
    if (msg.type !== "user" && msg.type !== "assistant") return true

    // Resolve parentToolUseID for this agent.
    let parentToolId = agentToParentToolId.get(agentId)
    if (!parentToolId) {
      // Match by prompt: the subagent's first user message text should match
      // a pending Task tool call's prompt.
      const message = typeof msg.message === "object" && msg.message !== null
        ? msg.message as Record<string, unknown>
        : null
      const msgContent = message?.content
      let promptText = ""
      if (typeof msgContent === "string") {
        promptText = msgContent
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (
            typeof block === "object"
            && block !== null
            && (block as Record<string, unknown>).type === "text"
            && typeof (block as Record<string, unknown>).text === "string"
          ) {
            promptText = (block as Record<string, string>).text
            break
          }
        }
      }
      if (promptText) {
        const match = resolveParentToolId(promptText)
        if (match) {
          // Displacing a provisional holder leaves it unresolved, which beats
          // leaving the agent that can prove ownership with nothing.
          const displaced = claims.get(match.toolId)
          if (displaced) agentToParentToolId.delete(displaced.agentId)
          claims.set(match.toolId, { agentId, proven: match.proven })
          agentToParentToolId.set(agentId, match.toolId)
          parentToolId = match.toolId
        }
      }
    }
    if (!parentToolId) return true

    const progressEntry = {
      type: "progress",
      parentUuid: "",
      isSidechain: false,
      cwd: typeof msg.cwd === "string" ? msg.cwd : "",
      sessionId,
      uuid: randomUUID(),
      timestamp: typeof msg.timestamp === "string" ? msg.timestamp : new Date().toISOString(),
      parentToolUseID: parentToolId,
      toolUseID: `agent_msg_synth_${randomUUID().slice(0, 12)}`,
      data: {
        type: "agent_progress",
        agentId,
        prompt: "",
        normalizedMessages: [],
        message: {
          type: msg.type,
          message: msg.message,
          uuid: typeof msg.uuid === "string" ? msg.uuid : randomUUID(),
          timestamp: typeof msg.timestamp === "string" ? msg.timestamp : new Date().toISOString(),
        },
      },
    }

    try {
      await appendFile(parentJsonlPath, `${JSON.stringify(progressEntry)}\n`)
      return true
    } catch {
      // Do not commit the source offset; retry this record on the next scan.
      return false
    }
  }

  async function processAgentFile(filePath: string, agentFileName: string): Promise<void> {
    if (closed) return
    const agentId = agentFileName.replace("agent-", "").replace(".jsonl", "")
    let committedOffset = fileOffsets.get(filePath) ?? 0

    try {
      const s = await stat(filePath)
      if (s.size < committedOffset) {
        committedOffset = 0
        fileOffsets.set(filePath, 0)
      }
      if (s.size <= committedOffset) return

      const fh = await open(filePath, "r")
      try {
        let readOffset = committedOffset
        let pending = Buffer.alloc(0)
        let pendingOffset = committedOffset

        while (!closed && readOffset < s.size) {
          const bytesToRead = Math.min(s.size - readOffset, READ_CHUNK_BYTES)
          const buf = Buffer.alloc(bytesToRead)
          const { bytesRead } = await fh.read(buf, 0, buf.length, readOffset)
          if (bytesRead <= 0) return
          readOffset += bytesRead
          recordActivity("Subagent JSONL reads", { bytes: bytesRead })
          pending = Buffer.concat([pending, buf.subarray(0, bytesRead)])

          let newlineIndex = pending.indexOf(0x0a)
          while (newlineIndex >= 0) {
            const nextOffset = pendingOffset + newlineIndex + 1
            const line = pending.subarray(0, newlineIndex).toString("utf8")
            if (line && !(await forwardLine(line, agentId))) return
            committedOffset = nextOffset
            fileOffsets.set(filePath, committedOffset)
            pending = pending.subarray(newlineIndex + 1)
            pendingOffset = nextOffset
            newlineIndex = pending.indexOf(0x0a)
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      // file may not exist yet
    }
  }

  function scanDir(): Promise<void> {
    if (closed) return Promise.resolve()
    if (scanInFlight) {
      scanRequested = true
      return scanInFlight
    }

    scanInFlight = (async () => {
      recordActivity("Subagent directory scans")
      try {
        const files = await readdir(subagentsDir)
        if (files.length > 0) {
          recordActivity("Subagent files checked", { count: files.length })
        }
        for (const fileName of files) {
          if (fileName.startsWith("agent-") && fileName.endsWith(".jsonl")) {
            await processAgentFile(join(subagentsDir, fileName), fileName)
          }
        }
      } catch {
        // Directory may not exist yet.
      }
    })().finally(() => {
      scanInFlight = null
      if (scanRequested && !closed) {
        scanRequested = false
        void scanDir()
      }
    })
    return scanInFlight
  }

  // Watch the subagents directory for changes
  try {
    dirWatcher = watch(subagentsDir, { recursive: true }, () => {
      if (!closed) void scanDir()
    })
    dirWatcher.on("error", () => {}) // dir may not exist yet
  } catch {
    // directory doesn't exist yet — poller will pick up changes
  }

  // Poll only as a fallback (subagents dir may be created after we start
  // watching). fs.watch remains immediate when the directory already exists;
  // a two-second fallback avoids four unnecessary scans out of every five.
  pollTimer = setInterval(scanDir, 2_000)

  // Initial scan
  void scanDir()

  return {
    close() {
      closed = true
      dirWatcher?.close()
      dirWatcher = null
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
    },
  }
}
