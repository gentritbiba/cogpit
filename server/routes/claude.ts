import {
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  watchSubagents,
  spawn,
  createInterface,
  homedir,
  buildPermArgs,
  buildMcpArgs,
  buildCodexPermArgs,
  buildCodexModelArgs,
  buildCodexEffortArgs,
  writeTempImageFiles,
  cleanupTempFiles,
  getAgentKindFromSessionPath,
  getSessionMeta,
  friendlySpawnError,
} from "../helpers"
import type { PersistentSession, UseFn } from "../helpers"
import { buildStreamMessage as buildClaudeStreamMessage, CODEX_IMAGE_ONLY_PROMPT } from "../lib/streamMessage"

export function registerClaudeRoutes(use: UseFn) {
  use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { sessionId, message, images, cwd, permissions, model, effort, mcpConfig } = JSON.parse(body)

        if (!sessionId || (!message && (!images || images.length === 0))) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "sessionId and message or images are required" }))
          return
        }

        const existing = persistentSessions.get(sessionId)
        const sessionPath = existing?.jsonlPath ?? await findJsonlPath(sessionId)
        const agentKind = existing?.agentKind ?? getAgentKindFromSessionPath(sessionPath)

        if (agentKind === "codex") {
          if (existing && !existing.dead) {
            res.statusCode = 409
            res.end(JSON.stringify({ error: "Session is already active" }))
            return
          }

          const imagePaths = await writeTempImageFiles(images)
          const permArgs = buildCodexPermArgs(permissions)
          const modelArgs = buildCodexModelArgs(model)
          const effortArgs = buildCodexEffortArgs(effort)
          const imageArgs = imagePaths.flatMap((filePath) => ["-i", filePath])
          const sessionMeta = sessionPath ? await getSessionMeta(sessionPath).catch(() => null) : null
          const prompt = message || (imagePaths.length > 0 ? CODEX_IMAGE_ONLY_PROMPT : "")

          const child = spawn(
            "codex",
            [
              "exec",
              "resume",
              "--json",
              ...permArgs,
              ...modelArgs,
              ...effortArgs,
              ...imageArgs,
              sessionId,
              ...(prompt ? [prompt] : []),
            ],
            {
              cwd: cwd || sessionMeta?.cwd || homedir(),
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            }
          )

          const ps: PersistentSession = {
            agentKind: "codex",
            proc: child,
            onResult: null,
            dead: false,
            cwd: cwd || sessionMeta?.cwd || homedir(),
            permArgs,
            modelArgs,
            effortArgs,
            jsonlPath: sessionPath,
            pendingTaskCalls: new Map(),
            subagentWatcher: null,
            worktreeName: null,
          }
          persistentSessions.set(sessionId, ps)
          activeProcesses.set(sessionId, child)

          child.stdout?.on("data", () => {})

          let persistentStderr = ""
          child.stderr?.on("data", (data: Buffer) => {
            persistentStderr += data.toString()
          })

          const finish = async () => {
            await cleanupTempFiles(imagePaths)
            activeProcesses.delete(sessionId)
            persistentSessions.delete(sessionId)
          }

          child.on("close", async (code) => {
            ps.dead = true
            await finish()
            if (ps.onResult) {
              const wasKilled = code === null || code === 143 || code === 137
              ps.onResult({
                type: "result",
                subtype: wasKilled || code === 0 ? "success" : "error",
                is_error: !(wasKilled || code === 0),
                result: wasKilled || code === 0
                  ? undefined
                  : persistentStderr.trim() || `codex exited with code ${code}`,
              })
            }
          })

          child.on("error", async (err: NodeJS.ErrnoException) => {
            ps.dead = true
            await finish()
            if (ps.onResult) {
              ps.onResult({ type: "result", is_error: true, result: friendlySpawnError(err, "codex") })
            }
          })

          let responded = false
          ps.onResult = (result) => {
            if (responded) return
            responded = true
            ps.onResult = null
            res.setHeader("Content-Type", "application/json")
            if (result.is_error) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: result.result || "Codex returned an error" }))
            } else {
              res.end(JSON.stringify({ success: true }))
            }
          }
          return
        }

        const permArgs = buildPermArgs(permissions)
        const modelArgs = model ? ["--model", model] : []
        const effortArgs = effort ? ["--effort", effort] : []
        const mcpArgs = buildMcpArgs(mcpConfig)
        const streamMsg = buildClaudeStreamMessage(message, images)

        if (existing && !existing.dead) {
          activeProcesses.set(sessionId, existing.proc)
          let responded = false
          existing.onResult = (result) => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            existing.onResult = null
            res.setHeader("Content-Type", "application/json")
            if (result.is_error) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: result.result || "Claude returned an error" }))
            } else {
              res.end(JSON.stringify({ success: true }))
            }
          }

          const onDeath = () => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            existing.onResult = null
            res.statusCode = 500
            res.end(JSON.stringify({ error: "Claude process died unexpectedly" }))
          }
          existing.proc.once("close", onDeath)
          existing.proc.stdin?.write(streamMsg + "\n")
          return
        }

        if (existing) persistentSessions.delete(sessionId)

        const cleanEnv = { ...process.env }
        delete cleanEnv.CLAUDECODE

        const child = spawn(
          "claude",
          [
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--resume", sessionId,
            ...permArgs,
            ...modelArgs,
            ...effortArgs,
            ...mcpArgs,
          ],
          {
            cwd: cwd || homedir(),
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
          }
        )

        const ps: PersistentSession = {
          agentKind: "claude",
          proc: child,
          onResult: null,
          dead: false,
          cwd: cwd || homedir(),
          permArgs,
          modelArgs,
          effortArgs,
          jsonlPath: null,
          pendingTaskCalls: new Map(),
          subagentWatcher: null,
          worktreeName: null,
        }
        persistentSessions.set(sessionId, ps)
        activeProcesses.set(sessionId, child)

        findJsonlPath(sessionId).then((p) => {
          ps.jsonlPath = p
          if (p) {
            ps.subagentWatcher = watchSubagents(p, sessionId, ps.pendingTaskCalls)
          }
        })

        const rl = createInterface({ input: child.stdout! })
        rl.on("line", (line) => {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === "result" && ps.onResult) {
              ps.onResult(parsed)
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

        let responded = false
        ps.onResult = (result) => {
          if (responded) return
          responded = true
          activeProcesses.delete(sessionId)
          ps.onResult = null
          res.setHeader("Content-Type", "application/json")
          if (result.is_error) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: result.result || "Claude returned an error" }))
          } else {
            res.end(JSON.stringify({ success: true }))
          }
        }

        child.stdin?.write(streamMsg + "\n")
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
