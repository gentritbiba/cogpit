import {
  CODEX_SESSIONS_DIR,
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
  open,
  join,
  randomUUID,
  stat,
  buildPermArgs,
  buildMcpArgs,
  buildCodexPermArgs,
  buildCodexModelArgs,
  buildCodexEffortArgs,
  writeTempImageFiles,
  cleanupTempFiles,
  isCodexDirName,
  decodeCodexDirName,
  listCodexSessionFiles,
  findNewestCodexSessionForCwd,
  formatCodexRolloutFileName,
} from "../../helpers"
import type { PersistentSession, UseFn } from "../../helpers"
import { appendFile } from "node:fs/promises"
import { buildStreamMessage, CODEX_IMAGE_ONLY_PROMPT } from "../../lib/streamMessage"
export { buildStreamMessage } from "../../lib/streamMessage"

export async function resolveProjectPath(
  projectDir: string,
  dirName: string
): Promise<string> {
  try {
    const files = await readdir(projectDir)
    for (const f of files.filter((file) => file.endsWith(".jsonl"))) {
      try {
        const fh = await open(join(projectDir, f), "r")
        try {
          const buf = Buffer.alloc(8192)
          const { bytesRead } = await fh.read(buf, 0, 8192, 0)
          const lines = buf.subarray(0, bytesRead).toString("utf-8").split("\n")
          for (const line of lines) {
            if (!line) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.cwd) {
                return parsed.cwd
              }
            } catch {
              continue
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
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
}

async function waitForCodexSession(
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
  timeoutMs = 15_000
): Promise<{ filePath: string; fileName: string; sessionId: string } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = await findNewestCodexSessionForCwd(cwd, knownPaths, startedAt)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

function extractCodexSessionIdentity(line: string): { sessionId: string; fileName: string; filePath: string } | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; timestamp?: string; payload?: unknown }
    if (parsed.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object") return null

    const payload = parsed.payload as { id?: unknown; timestamp?: unknown }
    const sessionId = typeof payload.id === "string" ? payload.id : ""
    const timestampText = typeof payload.timestamp === "string"
      ? payload.timestamp
      : (typeof parsed.timestamp === "string" ? parsed.timestamp : "")
    if (!sessionId || !timestampText) return null

    const timestamp = new Date(timestampText)
    if (Number.isNaN(timestamp.getTime())) return null

    const fileName = formatCodexRolloutFileName(sessionId, timestamp)
    return {
      sessionId,
      fileName,
      filePath: join(CODEX_SESSIONS_DIR, fileName),
    }
  } catch {
    return null
  }
}

function registerTrackedSession(sessionId: string, ps: PersistentSession): void {
  persistentSessions.set(sessionId, ps)
  activeProcesses.set(sessionId, ps.proc)
}

function attachClaudeStdout(ps: PersistentSession, sessionId: string): void {
  const rl = createInterface({ input: ps.proc.stdout! })
  rl.on("line", (line) => {
    try {
      const parsed = JSON.parse(line)
      if (parsed.type === "result") {
        if (ps.onResult) ps.onResult(parsed)
        // Persist terminal_reason into the JSONL so the client can display it
        const reason = parsed.terminal_reason
        if (reason && reason !== "completed" && ps.jsonlPath) {
          const entry = JSON.stringify({ type: "system", subtype: "terminal_reason", reason, timestamp: new Date().toISOString() })
          appendFile(ps.jsonlPath, entry + "\n").catch(() => {})
        }
      }
      if (parsed.type === "assistant") {
        const content = parsed.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use" && (block.name === "Task" || block.name === "Agent")) {
              ps.pendingTaskCalls.set(block.id, block.input?.prompt ?? "")
            }
          }
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  })

  findJsonlPath(sessionId).then((p) => {
    ps.jsonlPath = p
    if (p) {
      ps.subagentWatcher = watchSubagents(p, sessionId, ps.pendingTaskCalls)
    }
  })
}

export function registerNewSessionRoute(use: UseFn) {
  use("/api/new-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, message, permissions, model, effort, name } = JSON.parse(body)

        if (!dirName || !message) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and message are required" }))
          return
        }

        if (isCodexDirName(dirName)) {
          const cwd = decodeCodexDirName(dirName)
          if (!cwd) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid Codex project" }))
            return
          }

          const knownPaths = new Set((await listCodexSessionFiles()).map((file) => file.filePath))
          const permArgs = buildCodexPermArgs(permissions)
          const modelArgs = buildCodexModelArgs(model)
          const effortArgs = buildCodexEffortArgs(effort)
          const startedAt = Date.now()
          const child = spawn(
            "codex",
            ["exec", "--json", ...permArgs, ...modelArgs, ...effortArgs, message],
            {
              cwd,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            }
          )

          let responded = false
          let createdSessionId: string | null = null
          const sessionMatchPromise = waitForCodexSession(cwd, knownPaths, startedAt, 60_000)
          const stdoutLines: string[] = []
          const rl = createInterface({ input: child.stdout! })
          rl.on("line", (line) => {
            if (stdoutLines.length < 64) stdoutLines.push(line)
            if (responded) return
            const identity = extractCodexSessionIdentity(line)
            if (!identity) return

            responded = true
            createdSessionId = identity.sessionId
            activeProcesses.set(identity.sessionId, child)
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({
              success: true,
              dirName,
              fileName: identity.fileName,
              sessionId: identity.sessionId,
              initialContent: stdoutLines.join("\n"),
            }))
          })

          let stderr = ""
          child.stderr?.on("data", (data: Buffer) => {
            stderr += data.toString()
          })

          ;(async () => {
            const match = await sessionMatchPromise
            if (!match) return
            createdSessionId ??= match.sessionId
            if (responded) return
            responded = true
            activeProcesses.set(match.sessionId, child)
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({
              success: true,
              dirName,
              fileName: match.fileName,
              sessionId: match.sessionId,
            }))
          })()

          child.on("error", (err: NodeJS.ErrnoException) => {
            if (responded) return
            responded = true
            res.statusCode = 500
            res.end(JSON.stringify({ error: friendlySpawnError(err, "codex") }))
          })

          child.on("close", async (code) => {
            if (createdSessionId) activeProcesses.delete(createdSessionId)
            if (responded) return
            if (code === 0) {
              const match = await sessionMatchPromise
              if (match) {
                responded = true
                createdSessionId = match.sessionId
                res.setHeader("Content-Type", "application/json")
                res.end(JSON.stringify({
                  success: true,
                  dirName,
                  fileName: match.fileName,
                  sessionId: match.sessionId,
                }))
                return
              }
            }
            responded = true
            res.statusCode = 500
            res.end(JSON.stringify({
              error: stderr.trim() || `codex exited with code ${code} before creating session`,
            }))
          })
          return
        }

        const projectDir = join(dirs.PROJECTS_DIR, dirName)
        if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        const projectPath = await resolveProjectPath(projectDir, dirName)
        const permArgs = buildPermArgs(permissions)
        const modelArgs = model ? ["--model", model] : []
        const effortArgs = effort ? ["--effort", effort] : []
        const nameArgs = name ? ["--name", name] : []
        const sessionId = randomUUID()
        const fileName = `${sessionId}.jsonl`

        const cleanEnv = { ...process.env }
        delete cleanEnv.CLAUDECODE

        const child = spawn(
          "claude",
          ["-p", message, "--session-id", sessionId, ...permArgs, ...modelArgs, ...effortArgs, ...nameArgs],
          {
            cwd: projectPath,
            env: cleanEnv,
            stdio: ["ignore", "pipe", "pipe"],
          }
        )

        let stderr = ""
        child.stdout?.on("data", () => {})
        child.stderr?.on("data", (data: Buffer) => {
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
            res.end(JSON.stringify({ error: stderr.trim() || "Timed out waiting for session to start" }))
          }
        }, 60000)

        child.on("error", (err: NodeJS.ErrnoException) => {
          if (responded) return
          responded = true
          clearTimeout(timeout)
          res.statusCode = 500
          res.end(JSON.stringify({ error: friendlySpawnError(err) }))
        })

        child.on("close", async (code) => {
          if (responded) return
          responded = true
          clearTimeout(timeout)
          try {
            await stat(expectedPath)
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true, dirName, fileName, sessionId }))
          } catch {
            res.statusCode = 500
            res.end(JSON.stringify({
              error: stderr.trim() || `claude exited with code ${code} before creating session`,
            }))
          }
        })
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}

export function registerCreateAndSendRoute(use: UseFn) {
  use("/api/create-and-send", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, message, images, permissions, model, effort, worktreeName, mcpConfig, name } = JSON.parse(body)

        if (!dirName || (!message && (!images || !images.length))) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and message (or images) are required" }))
          return
        }

        if (isCodexDirName(dirName)) {
          const cwd = decodeCodexDirName(dirName)
          if (!cwd) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid Codex project" }))
            return
          }

          const knownPaths = new Set((await listCodexSessionFiles()).map((file) => file.filePath))
          const imagePaths = await writeTempImageFiles(images)
          const permArgs = buildCodexPermArgs(permissions)
          const modelArgs = buildCodexModelArgs(model)
          const effortArgs = buildCodexEffortArgs(effort)
          const imageArgs = imagePaths.flatMap((filePath) => ["-i", filePath])
          const prompt = message || (imagePaths.length > 0 ? CODEX_IMAGE_ONLY_PROMPT : "")
          const startedAt = Date.now()

          const child = spawn(
            "codex",
            [
              "exec",
              "--json",
              ...permArgs,
              ...modelArgs,
              ...effortArgs,
              ...imageArgs,
              ...(prompt ? [prompt] : []),
            ],
            {
              cwd,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            }
          )

          let persistentStderr = ""
          child.stderr?.on("data", (data: Buffer) => {
            persistentStderr += data.toString()
          })

          let sessionId: string | null = null
          let responded = false
          const sessionMatchPromise = waitForCodexSession(cwd, knownPaths, startedAt)

          const ps: PersistentSession = {
            agentKind: "codex",
            proc: child,
            onResult: null,
            dead: false,
            cwd,
            permArgs,
            modelArgs,
            effortArgs,
            jsonlPath: null,
            pendingTaskCalls: new Map(),
            subagentWatcher: null,
            worktreeName: null,
          }

          const respondSuccess = async (
            fileName: string,
            filePath: string,
            discoveredSessionId: string,
            initialContent?: string,
          ) => {
            if (responded) return
            responded = true
            sessionId = discoveredSessionId
            ps.jsonlPath = filePath
            if (!ps.dead) {
              registerTrackedSession(discoveredSessionId, ps)
            }
            let responseInitialContent = initialContent?.trim() ? initialContent : undefined
            if (!responseInitialContent) {
              try {
                responseInitialContent = await readFile(filePath, "utf-8")
              } catch {
                // let client poll if needed
              }
            }
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({
              success: true,
              dirName,
              fileName,
              sessionId: discoveredSessionId,
              initialContent: responseInitialContent,
            }))
          }

          const respondError = (error: string) => {
            if (responded) return
            responded = true
            res.statusCode = 500
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error }))
          }

          const stdoutLines: string[] = []
          const rl = createInterface({ input: child.stdout! })
          rl.on("line", (line) => {
            if (stdoutLines.length < 128) stdoutLines.push(line)
            if (responded) return
            const identity = extractCodexSessionIdentity(line)
            if (!identity) return
            void respondSuccess(
              identity.fileName,
              identity.filePath,
              identity.sessionId,
              stdoutLines.join("\n"),
            )
          })

          ;(async () => {
            const match = await sessionMatchPromise
            if (!match) return
            if (sessionId === match.sessionId) {
              ps.jsonlPath = match.filePath
            }
            if (responded) return
            await respondSuccess(match.fileName, match.filePath, match.sessionId)
          })()

          child.on("close", async (code) => {
            ps.dead = true
            await cleanupTempFiles(imagePaths)
            if (sessionId) {
              activeProcesses.delete(sessionId)
              persistentSessions.delete(sessionId)
            }
            if (responded) return
            if (code === 0) {
              const match = await sessionMatchPromise
              if (match) {
                await respondSuccess(match.fileName, match.filePath, match.sessionId)
                return
              }
            }
            respondError(persistentStderr.trim() || `codex exited with code ${code}`)
          })

          child.on("error", async (err: NodeJS.ErrnoException) => {
            ps.dead = true
            await cleanupTempFiles(imagePaths)
            respondError(friendlySpawnError(err, "codex"))
          })

          return
        }

        const projectDir = join(dirs.PROJECTS_DIR, dirName)
        if (!isWithinDir(dirs.PROJECTS_DIR, projectDir)) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        const projectPath = await resolveProjectPath(projectDir, dirName)
        const permArgs = buildPermArgs(permissions)
        const modelArgs = model ? ["--model", model] : []
        const effortArgs = effort ? ["--effort", effort] : []
        const nameArgs = name ? ["--name", name] : []
        const worktreeArgs = worktreeName ? ["--worktree", worktreeName] : []
        const mcpArgs = buildMcpArgs(mcpConfig)
        const sessionId = randomUUID()
        const fileName = `${sessionId}.jsonl`
        const streamMsg = buildStreamMessage(message, images)

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
            ...effortArgs,
            ...nameArgs,
            ...worktreeArgs,
            ...mcpArgs,
          ],
          {
            cwd: projectPath,
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
          }
        )

        const ps: PersistentSession = {
          agentKind: "claude",
          proc: child,
          onResult: null,
          dead: false,
          cwd: projectPath,
          permArgs,
          modelArgs,
          effortArgs,
          jsonlPath: null,
          pendingTaskCalls: new Map(),
          subagentWatcher: null,
          worktreeName: worktreeName || null,
        }
        registerTrackedSession(sessionId, ps)
        attachClaudeStdout(ps, sessionId)

        let persistentStderr = ""
        child.stderr?.on("data", (data: Buffer) => {
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

        child.stdin?.write(streamMsg + "\n")

        let responded = false
        const expectedPath = join(projectDir, fileName)

        const respondSuccess = async () => {
          if (responded) return
          responded = true
          let initialContent: string | undefined
          try {
            initialContent = await readFile(expectedPath, "utf-8")
          } catch {
            // File may not be readable yet
          }
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true, dirName, fileName, sessionId, initialContent }))
        }

        const respondError = (error: string) => {
          if (responded) return
          responded = true
          res.statusCode = 500
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error }))
        }

        const pollForFile = async () => {
          const maxAttempts = 150
          for (let i = 0; i < maxAttempts; i++) {
            if (responded) return
            try {
              await stat(expectedPath)
              respondSuccess()
              ps.jsonlPath = expectedPath
              ps.subagentWatcher = watchSubagents(expectedPath, sessionId, ps.pendingTaskCalls)
              return
            } catch {
              // keep polling
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }

        pollForFile()

        ps.onResult = (result) => {
          ps.onResult = null
          if (result.is_error) {
            respondError(result.result || "Claude returned an error")
          } else {
            respondSuccess()
          }

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
}
