import { readdir, stat, open, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { watch } from "node:fs"
import { randomUUID } from "node:crypto"

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
 * @param pendingTaskCalls Map of tool_use_id -> prompt for active Task tool calls.
 *                         Updated externally by the stdout parser when it sees Task tool_use/result.
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
  let closed = false
  let dirWatcher: ReturnType<typeof watch> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function processAgentFile(filePath: string, agentFileName: string) {
    if (closed) return
    const agentId = agentFileName.replace("agent-", "").replace(".jsonl", "")
    const offset = fileOffsets.get(filePath) ?? 0

    try {
      const s = await stat(filePath)
      if (s.size <= offset) return

      const fh = await open(filePath, "r")
      try {
        const buf = Buffer.alloc(s.size - offset)
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
        fileOffsets.set(filePath, s.size)

        const text = buf.subarray(0, bytesRead).toString("utf-8")
        const lines = text.split("\n").filter(Boolean)

        for (const line of lines) {
          try {
            const msg = JSON.parse(line)
            if (msg.type !== "user" && msg.type !== "assistant") continue

            // Resolve parentToolUseID for this agent
            let parentToolId = agentToParentToolId.get(agentId)
            if (!parentToolId) {
              // Match by prompt: the subagent's first user message text
              // should match a pending Task tool call's prompt
              const msgContent = msg.message?.content
              let promptText = ""
              if (typeof msgContent === "string") {
                promptText = msgContent
              } else if (Array.isArray(msgContent)) {
                for (const b of msgContent) {
                  if (b.type === "text") { promptText = b.text; break }
                }
              }
              if (promptText) {
                for (const [toolId, taskPrompt] of pendingTaskCalls) {
                  if (taskPrompt === promptText || promptText.startsWith(taskPrompt.slice(0, 100))) {
                    parentToolId = toolId
                    agentToParentToolId.set(agentId, toolId)
                    break
                  }
                }
              }
            }
            if (!parentToolId) continue

            // Synthesize an agent_progress entry matching Claude Code's format
            const progressEntry = {
              type: "progress",
              parentUuid: "",
              isSidechain: false,
              cwd: msg.cwd || "",
              sessionId,
              uuid: randomUUID(),
              timestamp: msg.timestamp || new Date().toISOString(),
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
                  uuid: msg.uuid || randomUUID(),
                  timestamp: msg.timestamp || new Date().toISOString(),
                },
              },
            }

            await appendFile(parentJsonlPath, JSON.stringify(progressEntry) + "\n").catch(() => {})
          } catch {
            // skip malformed lines
          }
        }
      } finally {
        await fh.close()
      }
    } catch {
      // file may not exist yet
    }
  }

  async function scanDir() {
    if (closed) return
    try {
      const files = await readdir(subagentsDir)
      for (const f of files) {
        if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
          await processAgentFile(join(subagentsDir, f), f)
        }
      }
    } catch {
      // directory may not exist yet
    }
  }

  // Watch the subagents directory for changes
  try {
    dirWatcher = watch(subagentsDir, { recursive: true }, () => {
      if (!closed) scanDir()
    })
    dirWatcher.on("error", () => {}) // dir may not exist yet
  } catch {
    // directory doesn't exist yet — poller will pick up changes
  }

  // Poll as fallback (subagents dir may be created after we start watching)
  pollTimer = setInterval(scanDir, 500)

  // Initial scan
  scanDir()

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
