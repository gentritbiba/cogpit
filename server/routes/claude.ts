import {
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  spawn,
  homedir,
  buildCodexPermArgs,
  buildCodexModelArgs,
  buildCodexEffortArgs,
  buildCodexFastModeArgs,
  writeTempImageFiles,
  cleanupTempFiles,
  getAgentKindFromSessionPath,
  getSessionMeta,
  friendlySpawnError,
} from "../helpers"
import type { PersistentSession, UseFn } from "../helpers"
import { buildStreamMessage as buildClaudeStreamMessage, CODEX_IMAGE_ONLY_PROMPT } from "../lib/streamMessage"
import { sdkSessions, sendSDKMessage, resumeSDKSession, attachSubagentWatcher } from "../sdk-session"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import { codexAppServer } from "../codex-app-server"
import {
  continueCodexExecution,
  isCodexAppServerUnavailable,
} from "../lib/codexExecution"

export function registerClaudeRoutes(use: UseFn) {
  use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { sessionId, message, images, cwd, permissions, model, effort, fastMode, ultracode, mcpConfig } = JSON.parse(body)

        if (!sessionId || (!message && (!images || images.length === 0))) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId and message or images are required"))
          return
        }

        const existing = persistentSessions.get(sessionId)
        const sessionPath = existing?.jsonlPath ?? await findJsonlPath(sessionId)
        const agentKind = existing?.agentKind ?? getAgentKindFromSessionPath(sessionPath)

        if (agentKind === "codex") {
          if (existing && !existing.dead) {
            sendError(res, new RouteError(409, ErrorCodes.CONFLICT, "Session is already active"))
            return
          }

          const sessionMeta = sessionPath ? await getSessionMeta(sessionPath).catch(() => null) : null
          const resolvedCwd = cwd || sessionMeta?.cwd || homedir()
          try {
            await continueCodexExecution(
              codexAppServer,
              sessionId,
              sessionPath,
              {
                cwd: resolvedCwd,
                message,
                images,
                permissions,
                model,
                effort,
                fastMode,
              },
            )
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ success: true }))
            return
          } catch (error) {
            if (!isCodexAppServerUnavailable(error)) {
              sendError(res, new RouteError(
                500,
                ErrorCodes.INTERNAL_ERROR,
                error instanceof Error ? error.message : "Codex failed to accept the message",
              ))
              return
            }
          }

          // Compatibility path for Codex versions that predate app-server.
          const imagePaths = await writeTempImageFiles(images)
          const permArgs = buildCodexPermArgs(permissions)
          const modelArgs = buildCodexModelArgs(model)
          const effortArgs = buildCodexEffortArgs(effort)
          const fastModeArgs = buildCodexFastModeArgs(fastMode)
          const imageArgs = imagePaths.flatMap((filePath) => ["-i", filePath])
          const prompt = message || (imagePaths.length > 0 ? CODEX_IMAGE_ONLY_PROMPT : "")

          const child = spawn(
            "codex",
            [
              "exec",
              ...permArgs,
              "resume",
              "--json",
              ...modelArgs,
              ...effortArgs,
              ...fastModeArgs,
              ...imageArgs,
              sessionId,
              ...(prompt ? [prompt] : []),
            ],
            {
              cwd: resolvedCwd,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
            }
          )

          const ps: PersistentSession = {
            agentKind: "codex",
            proc: child,
            onResult: null,
            dead: false,
            cwd: resolvedCwd,
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
              sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, result.result || "Codex returned an error"))
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
          // and forward the latest model/effort/mcpConfig so both the
          // running Query and any subsequent restart see fresh values.
          const state = sendSDKMessage(sessionId, message, images, {
            model,
            effort,
            fastMode,
            ultracode,
            mcpConfig,
          })
          if (!state) {
            sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Failed to send message to running session"))
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
              sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, result.result || "Claude returned an error"))
            } else {
              res.end(JSON.stringify({ success: true }))
            }
          }
          const onDeath = () => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            legacyPs.onResult = null
            sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Claude process died unexpectedly"))
          }
          legacyPs.proc.once("close", onDeath)
          legacyPs.proc.stdin?.write(streamMsg + "\n")
          return
        }

        if (legacyPs) persistentSessions.delete(sessionId)

        // Resume via Agent SDK — start a new query with resume.
        // Claude Code scopes --resume to the project directory derived from
        // cwd, so when the client omits cwd we must recover it from the
        // session's own metadata or the resume won't find the session.
        const resumeMeta = !cwd && sessionPath
          ? await getSessionMeta(sessionPath).catch(() => null)
          : null
        const sdkState = resumeSDKSession({
          sessionId,
          cwd: cwd || resumeMeta?.cwd || homedir(),
          message,
          images,
          permissionMode: permissions?.mode,
          allowedTools: permissions?.allowedTools,
          disallowedTools: permissions?.disallowedTools,
          model,
          effort,
          fastMode,
          ultracode,
          mcpConfig,
        })

        // Attach the sub-agent watcher so progress streams in real-time
        if (sessionPath) {
          sdkState.jsonlPath = sessionPath
          attachSubagentWatcher(sdkState)
        } else {
          findJsonlPath(sessionId).then((p) => {
            if (p) {
              sdkState.jsonlPath = p
              attachSubagentWatcher(sdkState)
            }
          })
        }

        let responded = false
        sdkState.onResult = (result) => {
          if (responded) return
          responded = true
          sdkState.onResult = null
          res.setHeader("Content-Type", "application/json")
          if ((result as Record<string, unknown>).is_error) {
            const { result: errResult, subtype } = result as Record<string, unknown>
            const errorMessage = errResult != null
              ? String(errResult)
              : `Claude returned an error${subtype ? ` (${subtype})` : ""}`
            sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, errorMessage))
          } else {
            res.end(JSON.stringify({ success: true }))
          }
        }
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    })
  })
}
