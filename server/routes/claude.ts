import {
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  spawn,
  homedir,
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
import { sdkSessions, sendSDKMessage, resumeSDKSession } from "../sdk-session"

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
            pendingPermissions: new Map(),
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

        // Check for an existing SDK session first
        const existingSDK = sdkSessions.get(sessionId)

        if (existingSDK && existingSDK.running) {
          // SDK session is alive — inject the message via streamInput()
          const state = sendSDKMessage(sessionId, message, images)
          if (!state) {
            res.statusCode = 500
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ error: "Failed to send message to running session" }))
            return
          }
          // The message was injected into the live stream — respond immediately.
          // The frontend watches the JSONL for real-time progress.
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true }))
          return
        }

        // Fallback: check for old-style persistent session (CLI-spawned)
        const legacyPs = persistentSessions.get(sessionId)
        if (legacyPs && !legacyPs.dead) {
          const streamMsg = buildClaudeStreamMessage(message, images)
          activeProcesses.set(sessionId, legacyPs.proc)
          let responded = false
          legacyPs.onResult = (result) => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            legacyPs.onResult = null
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
            legacyPs.onResult = null
            res.statusCode = 500
            res.end(JSON.stringify({ error: "Claude process died unexpectedly" }))
          }
          legacyPs.proc.once("close", onDeath)
          legacyPs.proc.stdin?.write(streamMsg + "\n")
          return
        }

        if (legacyPs) persistentSessions.delete(sessionId)

        // Resume via Agent SDK — start a new query with resume
        const sdkState = resumeSDKSession({
          sessionId,
          cwd: cwd || homedir(),
          message,
          images,
          permissionMode: permissions?.mode,
          allowedTools: permissions?.allowedTools,
          disallowedTools: permissions?.disallowedTools,
          model,
          effort,
          mcpConfig,
        })

        let responded = false
        sdkState.onResult = (result) => {
          if (responded) return
          responded = true
          sdkState.onResult = null
          res.setHeader("Content-Type", "application/json")
          if ((result as Record<string, unknown>).is_error) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String((result as Record<string, unknown>).result) || "Claude returned an error" }))
          } else {
            res.end(JSON.stringify({ success: true }))
          }
        }
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
