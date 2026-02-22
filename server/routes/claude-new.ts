import {
  dirs,
  isWithinDir,
  friendlySpawnError,
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  watchSubagents,
  spawn,
  createInterface,
  readdir,
  readFile,
  writeFile,
  open,
  join,
  randomUUID,
  stat,
} from "../helpers"
import type { PersistentSession, UseFn } from "../helpers"

export function registerClaudeNewRoutes(use: UseFn) {
  // POST /api/new-session - create a new Claude session in a project
  use("/api/new-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, message, permissions } = JSON.parse(body)

        if (!dirName || !message) {
          res.statusCode = 400
          res.end(
            JSON.stringify({ error: "dirName and message are required" })
          )
          return
        }

        const projectDir = join(dirs.PROJECTS_DIR, dirName)
        if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        // Read the actual cwd from an existing session's JSONL
        let projectPath: string | null = null
        try {
          const files = await readdir(projectDir)
          for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
            try {
              const fh = await open(join(projectDir, f), "r")
              try {
                const buf = Buffer.alloc(4096)
                const { bytesRead } = await fh.read(buf, 0, 4096, 0)
                const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0]
                if (firstLine) {
                  const parsed = JSON.parse(firstLine)
                  if (parsed.cwd) {
                    projectPath = parsed.cwd
                    break
                  }
                }
              } finally {
                await fh.close()
              }
            } catch {
              continue
            }
          }
        } catch {
          // projectDir might not exist yet
        }
        if (!projectPath) {
          projectPath = "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
        }

        // Build permission args
        let permArgs: string[]
        if (permissions && typeof permissions.mode === "string" && permissions.mode !== "bypassPermissions") {
          permArgs = ["--permission-mode", permissions.mode]
          if (Array.isArray(permissions.allowedTools)) {
            for (const tool of permissions.allowedTools) {
              permArgs.push("--allowedTools", tool)
            }
          }
          if (Array.isArray(permissions.disallowedTools)) {
            for (const tool of permissions.disallowedTools) {
              permArgs.push("--disallowedTools", tool)
            }
          }
        } else {
          permArgs = ["--dangerously-skip-permissions"]
        }

        const sessionId = randomUUID()
        const fileName = `${sessionId}.jsonl`

        const cleanEnv = { ...process.env }
        delete cleanEnv.CLAUDECODE

        const child = spawn(
          "claude",
          ["-p", message, "--session-id", sessionId, ...permArgs],
          {
            cwd: projectPath,
            env: cleanEnv,
            stdio: ["ignore", "pipe", "pipe"],
          }
        )

        let stderr = ""
        child.stdout!.on("data", () => {})
        child.stderr!.on("data", (data: Buffer) => {
          stderr += data.toString()
        })

        activeProcesses.set(sessionId, child)
        child.on("close", () => {
          activeProcesses.delete(sessionId)
        })

        let responded = false
        const expectedPath = join(projectDir, fileName)

        const timeout = setTimeout(() => {
          if (!responded) {
            responded = true
            child.kill("SIGTERM")
            res.statusCode = 500
            res.end(
              JSON.stringify({
                error: stderr.trim() || "Timed out waiting for session to start",
              })
            )
          }
        }, 60000)

        child.on("error", (err: NodeJS.ErrnoException) => {
          if (!responded) {
            responded = true
            clearTimeout(timeout)
            res.statusCode = 500
            res.end(JSON.stringify({ error: friendlySpawnError(err) }))
          }
        })

        child.on("close", async (code) => {
          if (responded) return
          responded = true
          clearTimeout(timeout)

          try {
            await stat(expectedPath)
            res.setHeader("Content-Type", "application/json")
            res.end(
              JSON.stringify({
                success: true,
                dirName,
                fileName,
                sessionId,
              })
            )
          } catch {
            res.statusCode = 500
            res.end(
              JSON.stringify({
                error:
                  stderr.trim() ||
                  `claude exited with code ${code} before creating session`,
              })
            )
          }
        })
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  // POST /api/create-and-send - create a new session AND send the first message
  // Combines session creation with the first user message in one step (lazy creation).
  use("/api/create-and-send", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, message, images, permissions, model, worktreeName } = JSON.parse(body)

        if (!dirName || (!message && (!images || !images.length))) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and message (or images) are required" }))
          return
        }

        const projectDir = join(dirs.PROJECTS_DIR, dirName)
        if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        // Resolve project cwd from existing sessions
        let projectPath: string | null = null
        try {
          const files = await readdir(projectDir)
          for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
            try {
              const fh = await open(join(projectDir, f), "r")
              try {
                const buf = Buffer.alloc(4096)
                const { bytesRead } = await fh.read(buf, 0, 4096, 0)
                const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0]
                if (firstLine) {
                  const parsed = JSON.parse(firstLine)
                  if (parsed.cwd) {
                    projectPath = parsed.cwd
                    break
                  }
                }
              } finally {
                await fh.close()
              }
            } catch {
              continue
            }
          }
        } catch {
          // projectDir might not exist yet
        }
        if (!projectPath) {
          projectPath = "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
        }

        // Build permission args
        let permArgs: string[]
        if (permissions && typeof permissions.mode === "string" && permissions.mode !== "bypassPermissions") {
          permArgs = ["--permission-mode", permissions.mode]
          if (Array.isArray(permissions.allowedTools)) {
            for (const tool of permissions.allowedTools) {
              permArgs.push("--allowedTools", tool)
            }
          }
          if (Array.isArray(permissions.disallowedTools)) {
            for (const tool of permissions.disallowedTools) {
              permArgs.push("--disallowedTools", tool)
            }
          }
        } else {
          permArgs = ["--dangerously-skip-permissions"]
        }

        const modelArgs = model ? ["--model", model] : []
        const worktreeArgs = worktreeName ? ["--worktree", worktreeName] : []
        const sessionId = randomUUID()
        const fileName = `${sessionId}.jsonl`

        // Build stream-json user message
        const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
        const contentBlocks: unknown[] = []
        if (Array.isArray(images)) {
          for (const img of images as Array<{ data: string; mediaType: string }>) {
            const mediaType = ALLOWED_IMAGE_TYPES.has(img.mediaType) ? img.mediaType : "image/png"
            contentBlocks.push({
              type: "image",
              source: { type: "base64", media_type: mediaType, data: img.data },
            })
          }
        }
        if (message) {
          contentBlocks.push({ type: "text", text: message })
        }
        const streamMsg = JSON.stringify({
          type: "user",
          message: { role: "user", content: contentBlocks },
        })

        const cleanEnv = { ...process.env }
        delete cleanEnv.CLAUDECODE

        const child = spawn(
          "claude",
          [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--session-id", sessionId,
            ...permArgs,
            ...modelArgs,
            ...worktreeArgs,
          ],
          {
            cwd: projectPath,
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
          }
        )

        const ps: PersistentSession = {
          proc: child,
          onResult: null,
          dead: false,
          cwd: projectPath,
          permArgs,
          modelArgs,
          jsonlPath: null,
          pendingTaskCalls: new Map(),
          subagentWatcher: null,
          worktreeName: worktreeName || null,
        }
        persistentSessions.set(sessionId, ps)
        activeProcesses.set(sessionId, child)

        // Read stdout for result messages and track Task tool calls
        const rl = createInterface({ input: child.stdout! })
        rl.on("line", (line) => {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === "result" && ps.onResult) {
              ps.onResult(parsed)
            }
            // Track Task tool calls so the subagent watcher can match files
            if (parsed.type === "assistant") {
              const content = parsed.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_use" && block.name === "Task") {
                    ps.pendingTaskCalls.set(block.id, block.input?.prompt ?? "")
                  }
                }
              }
            }
          } catch {
            // ignore non-JSON lines
          }
        })

        let persistentStderr = ""
        child.stderr!.on("data", (data: Buffer) => {
          persistentStderr += data.toString()
        })

        child.on("close", (code) => {
          ps.dead = true
          ps.subagentWatcher?.close()
          activeProcesses.delete(sessionId)
          persistentSessions.delete(sessionId)
          if (ps.onResult) {
            const wasKilled = code === null || code === 143 || code === 137
            ps.onResult({
              type: "result",
              subtype: wasKilled ? "success" : "error",
              is_error: !wasKilled,
              result: wasKilled
                ? undefined
                : persistentStderr.trim() || `claude exited with code ${code}`,
            })
          }
        })

        child.on("error", (err: NodeJS.ErrnoException) => {
          ps.dead = true
          ps.subagentWatcher?.close()
          activeProcesses.delete(sessionId)
          persistentSessions.delete(sessionId)
          if (ps.onResult) {
            ps.onResult({ type: "result", is_error: true, result: friendlySpawnError(err) })
          }
        })

        // Send the first user message
        child.stdin!.write(streamMsg + "\n")

        // Respond as soon as the JSONL file exists on disk with content,
        // so the client can redirect immediately and stream via SSE.
        // Don't wait for the entire first turn to complete.
        let responded = false
        const expectedPath = join(projectDir, fileName)

        const respondSuccess = () => {
          if (responded) return
          responded = true
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, dirName, fileName, sessionId }))
        }

        const respondError = (error: string) => {
          if (responded) return
          responded = true
          res.statusCode = 500
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error }))
        }

        // Poll for the JSONL file to appear on disk with content
        const pollForFile = async () => {
          const maxAttempts = 150 // 15 seconds max (100ms intervals)
          for (let i = 0; i < maxAttempts; i++) {
            if (responded) return // error/close handler already responded
            try {
              const s = await stat(expectedPath)
              if (s.size > 0) {
                respondSuccess()

                // Now resolve JSONL path for subagent watcher
                ps.jsonlPath = expectedPath
                ps.subagentWatcher = watchSubagents(expectedPath, sessionId, ps.pendingTaskCalls)
                return
              }
            } catch {
              // File doesn't exist yet, keep polling
            }
            await new Promise(r => setTimeout(r, 100))
          }
          // Timed out — file never appeared. Fall through to let onResult handle it.
        }

        pollForFile()

        // If the process finishes or errors before we've responded, handle it
        ps.onResult = (result) => {
          ps.onResult = null
          if (result.is_error) {
            respondError(result.result || "Claude returned an error")
          } else {
            // Process completed its first turn — respond if we haven't already
            respondSuccess()
          }

          // Resolve JSONL path for subagent watcher if not already done
          if (!ps.jsonlPath) {
            findJsonlPath(sessionId).then((p) => {
              if (p) {
                ps.jsonlPath = p
                ps.subagentWatcher = watchSubagents(p, sessionId, ps.pendingTaskCalls)
              }
            })
          }
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })

  // POST /api/branch-session - create a branch (copy) of an existing session
  use("/api/branch-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, fileName, turnIndex } = JSON.parse(body)

        if (!dirName || !fileName) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and fileName are required" }))
          return
        }

        const sourcePath = join(dirs.PROJECTS_DIR, dirName, fileName)
        if (!isWithinDir(dirs.PROJECTS_DIR, sourcePath)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        const content = await readFile(sourcePath, "utf-8")
        let lines = content.split("\n").filter(Boolean)

        if (lines.length === 0) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Source session is empty" }))
          return
        }

        // If turnIndex is provided, truncate lines after that turn
        if (turnIndex != null) {
          const truncLine = findTruncationLine(lines, turnIndex)
          if (truncLine !== null) {
            lines = lines.slice(0, truncLine)
          }
          // If truncLine is null, turnIndex >= total turns — keep everything
        }

        // Rewrite first line with new sessionId and branchedFrom
        const firstObj = JSON.parse(lines[0])
        const originalId = firstObj.sessionId || ""
        const newSessionId = randomUUID()
        firstObj.sessionId = newSessionId
        firstObj.branchedFrom = {
          sessionId: originalId,
          turnIndex: turnIndex ?? null,
        }
        lines[0] = JSON.stringify(firstObj)

        const newFileName = `${newSessionId}.jsonl`
        const newPath = join(dirs.PROJECTS_DIR, dirName, newFileName)
        await writeFile(newPath, lines.join("\n") + "\n")

        res.setHeader("Content-Type", "application/json")
        res.end(
          JSON.stringify({
            dirName,
            fileName: newFileName,
            sessionId: newSessionId,
            branchedFrom: originalId,
          })
        )
      } catch (err) {
        res.statusCode = 400
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Invalid request",
          })
        )
      }
    })
  })

}

/**
 * Find the JSONL line index where the turn AFTER targetTurnIndex starts.
 * Returns null if targetTurnIndex >= total turns (keep everything).
 */
function findTruncationLine(
  lines: string[],
  targetTurnIndex: number
): number | null {
  let turnCount = 0
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i])
      if (obj.type === "user" && !obj.isMeta) {
        const content = obj.message?.content
        // Skip tool-result-only user messages
        if (
          Array.isArray(content) &&
          content.every((b: { type: string }) => b.type === "tool_result")
        ) {
          continue
        }
        if (turnCount === targetTurnIndex + 1) return i
        turnCount++
      }
    } catch {
      /* skip malformed */
    }
  }
  return null
}
