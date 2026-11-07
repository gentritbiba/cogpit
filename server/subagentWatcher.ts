import { readdir, stat, open, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { watch } from "node:fs"
import { randomUUID } from "node:crypto"
import { recordActivity } from "./lib/activityMonitor"

const READ_CHUNK_BYTES = 256 * 1024
const WATCH_RETRY_MS = 2_000
const WATCH_BACKSTOP_MS = 30_000

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

/**
 * A subagent the CLI reported through `task_started`, keyed by its task id —
 * the same id that names its `agent-<id>.jsonl` transcript.
 */
export interface SubagentTask {
  /** The Agent tool call that launched it. */
  toolUseId: string
  /** Task id of the subagent that launched it; absent when the main thread did. */
  parentTaskId?: string
  subagentType?: string
  /** Bytes of its transcript already forwarded, so a later watcher does not repeat them. */
  forwardedBytes: number
}

export interface SubagentWatcher {
  close(): void
  /** Look again now, for a subagent bound after its transcript appeared. */
  rescan(): void
}

/**
 * Watch for subagent JSONL files and forward their content as agent_progress
 * entries into the parent session JSONL.
 *
 * Only transcripts of tasks in `tasks` are read: the file name is the task id,
 * so a transcript is either bound exactly or left for a later scan.
 *
 * @param parentJsonlPath  Path to the parent session's JSONL file
 * @param sessionId        The parent session UUID
 * @param tasks            Subagents of this session by task id, owned by the caller
 */
function isAgentFile(fileName: string): boolean {
  return fileName.startsWith("agent-") && fileName.endsWith(".jsonl") && !/[/\\]/.test(fileName)
}

export function watchSubagents(
  parentJsonlPath: string,
  sessionId: string,
  tasks: ReadonlyMap<string, SubagentTask>,
): SubagentWatcher {
  const subagentsDir = parentJsonlPath.replace(/\.jsonl$/, "") + "/subagents"
  let closed = false

  /**
   * The Agent call in the main transcript a nested subagent's work belongs
   * under. An unknown parent counts as none, as the CLI documents.
   */
  function rootToolUseId(task: SubagentTask): string {
    const seen = new Set([task])
    let root = task
    let parent = tasks.get(root.parentTaskId ?? "")
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      root = parent
      parent = tasks.get(root.parentTaskId ?? "")
    }
    return root.toolUseId
  }

  let dirWatcher: ReturnType<typeof watch> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  /** Work waiting for the drain: a full directory scan, and single files fs events named. */
  let scanWanted = false
  const changedFiles = new Set<string>()
  let draining: Promise<void> | null = null

  async function forwardLine(line: string, agentId: string, task: SubagentTask): Promise<boolean> {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A newline-terminated malformed record cannot become valid later.
      return true
    }
    if (msg.type !== "user" && msg.type !== "assistant") return true

    const progressEntry = {
      type: "progress",
      parentUuid: "",
      isSidechain: false,
      cwd: typeof msg.cwd === "string" ? msg.cwd : "",
      sessionId,
      uuid: randomUUID(),
      timestamp: typeof msg.timestamp === "string" ? msg.timestamp : new Date().toISOString(),
      // A nested subagent's work is filed under the main-thread Agent call it
      // descends from; its own call and parent ride in `data` for nesting.
      parentToolUseID: rootToolUseId(task),
      toolUseID: `agent_msg_synth_${randomUUID().slice(0, 12)}`,
      data: {
        type: "agent_progress",
        agentId,
        toolUseId: task.toolUseId,
        ...(task.parentTaskId && tasks.has(task.parentTaskId) ? { parentAgentId: task.parentTaskId } : {}),
        ...(task.subagentType ? { subagentType: task.subagentType } : {}),
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
    const task = tasks.get(agentId)
    if (!task) return
    let committedOffset = task.forwardedBytes

    try {
      const s = await stat(filePath)
      if (s.size < committedOffset) {
        committedOffset = 0
        task.forwardedBytes = 0
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
            if (line && !(await forwardLine(line, agentId, task))) return
            committedOffset = nextOffset
            task.forwardedBytes = committedOffset
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

  async function scanDir(): Promise<void> {
    recordActivity("Subagent directory scans")
    let files: string[]
    try {
      files = await readdir(subagentsDir)
    } catch {
      return // Directory may not exist yet.
    }
    if (files.length > 0) {
      recordActivity("Subagent files checked", { count: files.length })
    }
    for (const fileName of files) {
      if (isAgentFile(fileName)) await processAgentFile(join(subagentsDir, fileName), fileName)
    }
  }

  /** One file or scan at a time, so a transcript's forwarded offset never races itself. */
  async function drain(): Promise<void> {
    while (!closed && (scanWanted || changedFiles.size > 0)) {
      if (scanWanted) {
        scanWanted = false
        changedFiles.clear()
        await scanDir()
        continue
      }
      const fileNames = [...changedFiles]
      changedFiles.clear()
      for (const fileName of fileNames) {
        await processAgentFile(join(subagentsDir, fileName), fileName)
      }
    }
  }

  /** Read `fileName` when given, else every transcript in the directory. */
  function request(fileName?: string): Promise<void> {
    if (closed) return Promise.resolve()
    if (fileName === undefined) scanWanted = true
    else changedFiles.add(fileName)
    draining ??= startDrain()
    return draining
  }

  function startDrain(): Promise<void> {
    return drain().finally(() => {
      draining = null
      // Work queued after the loop's last check but before this ran.
      if (!closed && (scanWanted || changedFiles.size > 0)) draining = startDrain()
    })
  }

  function attachDirectoryWatcher(): void {
    if (closed || dirWatcher) return
    try {
      const watcher = watch(subagentsDir, { recursive: true }, (_event, fileName) => {
        const name = typeof fileName === "string" ? fileName : null
        // Only the named transcript changed; anything else gets a full look.
        void request(name && isAgentFile(name) ? name : undefined)
      })
      dirWatcher = watcher
      watcher.on("error", () => {
        watcher.close()
        if (dirWatcher !== watcher) return
        dirWatcher = null
        schedulePoll()
      })
    } catch {
      // The directory is created only when the session starts a subagent.
    }
  }

  function schedulePoll(): void {
    if (pollTimer) clearTimeout(pollTimer)
    if (closed) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      attachDirectoryWatcher()
      void request().finally(() => {
        if (!closed) schedulePoll()
      })
    }, dirWatcher ? WATCH_BACKSTOP_MS : WATCH_RETRY_MS)
    pollTimer.unref?.()
  }

  attachDirectoryWatcher()
  schedulePoll()
  void request()

  return {
    rescan() {
      void request()
    },
    close() {
      closed = true
      dirWatcher?.close()
      dirWatcher = null
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
    },
  }
}
