import { isAbsolute } from "node:path"
import type { ServerResponse } from "node:http"
import { encodeClaudeDirName } from "../../../shared/providers/claude"
import {
  CODEX_SESSIONS_DIR,
  dirs,
  isWithinDir,
  friendlySpawnError,
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  spawn,
  createInterface,
  readdir,
  readFile,
  open,
  join,
  randomUUID,
  stat,
  buildPermArgs,
  buildCodexPermArgs,
  buildCodexModelArgs,
  buildCodexEffortArgs,
  buildCodexFastModeArgs,
  writeTempImageFiles,
  cleanupTempFiles,
  isCodexDirName,
  decodeCodexDirName,
  listCodexSessionFiles,
  findNewestCodexSessionForCwd,
  formatCodexRolloutFileName,
} from "../../helpers"
import type { UseFn } from "../../http"
import type { PersistentSession } from "../../helpers"
import { CODEX_IMAGE_ONLY_PROMPT } from "../../lib/streamMessage"
import { createSDKSession, attachSubagentWatcher } from "../../sdk-session"
import { RouteError, sendError, ErrorCodes } from "../../lib/routeError"
import { codexAppServer, type CodexThread } from "../../codex-app-server"
import {
  getCodexThreadIdentity,
  isCodexAppServerUnavailable,
  startCodexExecution,
  type CodexExecutionOptions,
} from "../../lib/codexExecution"
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

async function resolveCodexStartedThread(
  thread: CodexThread,
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
): Promise<{ filePath: string; fileName: string; sessionId: string }> {
  const direct = getCodexThreadIdentity(thread)
  if (direct) return direct

  const discovered = await waitForCodexSession(cwd, knownPaths, startedAt)
  if (discovered) return discovered
  throw new Error(`Codex created thread ${thread.id} but did not provide a rollout path`)
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

async function tryRespondWithCodexAppServerSession(
  res: ServerResponse,
  dirName: string,
  knownPaths: Set<string>,
  options: CodexExecutionOptions,
): Promise<boolean> {
  const startedAt = Date.now()
  try {
    const started = await startCodexExecution(codexAppServer, options)
    const identity = await resolveCodexStartedThread(
      started.thread,
      options.cwd,
      knownPaths,
      startedAt,
    )
    let initialContent: string | undefined
    try {
      initialContent = await readFile(identity.filePath, "utf-8")
    } catch {
      // The rollout can be materialized just after turn/start is accepted.
    }
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      success: true,
      dirName,
      fileName: identity.fileName,
      sessionId: identity.sessionId,
      initialContent,
    }))
    return true
  } catch (error) {
    if (isCodexAppServerUnavailable(error)) return false
    sendError(res, new RouteError(
      500,
      ErrorCodes.INTERNAL_ERROR,
      error instanceof Error ? error.message : "Failed to start Codex thread",
    ))
    return true
  }
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
        const { dirName, message, permissions, model, effort, fastMode, name } = JSON.parse(body)

        if (!dirName || !message) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "dirName and message are required"))
          return
        }

        if (isCodexDirName(dirName)) {
          const cwd = decodeCodexDirName(dirName)
          if (!cwd) {
            sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid Codex project"))
            return
          }

          const knownPaths = new Set((await listCodexSessionFiles()).map((file) => file.filePath))
          if (await tryRespondWithCodexAppServerSession(res, dirName, knownPaths, {
            cwd,
            message,
            permissions,
            model,
            effort,
            fastMode,
          })) return

          // Compatibility path for Codex versions that predate app-server.
          const permArgs = buildCodexPermArgs(permissions)
          const modelArgs = buildCodexModelArgs(model)
          const effortArgs = buildCodexEffortArgs(effort)
          const fastModeArgs = buildCodexFastModeArgs(fastMode)
          const startedAt = Date.now()
          const child = spawn(
            "codex",
            ["exec", "--json", ...permArgs, ...modelArgs, ...effortArgs, ...fastModeArgs, message],
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
          sendError(res, new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied"))
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
        const { dirName, cwd: requestedCwd, message, images, permissions, model, effort, fastMode, ultracode, worktreeName, mcpConfig, name } = JSON.parse(body)

        if (!dirName || (!message && (!images || !images.length))) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "dirName and message (or images) are required"))
          return
        }

        if (isCodexDirName(dirName)) {
          const cwd = decodeCodexDirName(dirName)
          if (!cwd) {
            sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid Codex project"))
            return
          }

          const knownPaths = new Set((await listCodexSessionFiles()).map((file) => file.filePath))
          if (await tryRespondWithCodexAppServerSession(res, dirName, knownPaths, {
            cwd,
            message,
            images,
            permissions,
            model,
            effort,
            fastMode,
          })) return

          // Compatibility path for Codex versions that predate app-server.
          const imagePaths = await writeTempImageFiles(images)
          const permArgs = buildCodexPermArgs(permissions)
          const modelArgs = buildCodexModelArgs(model)
          const effortArgs = buildCodexEffortArgs(effort)
          const fastModeArgs = buildCodexFastModeArgs(fastMode)
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
              ...fastModeArgs,
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
            pendingPermissions: new Map(),
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
          sendError(res, new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied"))
          return
        }

        if (requestedCwd !== undefined && (
          typeof requestedCwd !== "string" ||
          requestedCwd.includes("\0") ||
          !isAbsolute(requestedCwd)
        )) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "cwd must be a non-NUL absolute path"))
          return
        }
        if (requestedCwd !== undefined && encodeClaudeDirName(requestedCwd) !== dirName) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "cwd does not match dirName"))
          return
        }

        const projectPath = requestedCwd ?? await resolveProjectPath(projectDir, dirName)
        const sessionId = randomUUID()
        const fileName = `${sessionId}.jsonl`

        // Use the Agent SDK for Claude sessions
        const sdkState = createSDKSession({
          sessionId,
          cwd: projectPath,
          message,
          images,
          permissionMode: permissions?.mode,
          allowedTools: permissions?.allowedTools,
          disallowedTools: permissions?.disallowedTools,
          model,
          effort,
          fastMode,
          ultracode: !!ultracode,
          name,
          worktreeName,
          mcpConfig,
        })

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

        // Poll for the JSONL file to appear (SDK writes it automatically)
        const pollForFile = async () => {
          const maxAttempts = 150
          for (let i = 0; i < maxAttempts; i++) {
            if (responded) return
            try {
              await stat(expectedPath)
              respondSuccess()
              sdkState.jsonlPath = expectedPath
              attachSubagentWatcher(sdkState)
              return
            } catch {
              // keep polling
            }
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }

        pollForFile()

        sdkState.onResult = (result) => {
          sdkState.onResult = null
          if ((result as Record<string, unknown>).is_error) {
            respondError(String((result as Record<string, unknown>).result) || "Claude returned an error")
          } else {
            respondSuccess()
          }

          if (!sdkState.jsonlPath) {
            findJsonlPath(sessionId).then((p) => {
              if (p) {
                sdkState.jsonlPath = p
                attachSubagentWatcher(sdkState)
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
