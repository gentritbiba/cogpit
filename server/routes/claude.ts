import {
  friendlySpawnError,
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  spawn,
  createInterface,
  appendFile,
  homedir,
} from "../helpers"
import type { PersistentSession, UseFn } from "../helpers"

export function registerClaudeRoutes(use: UseFn) {
  // POST /api/send-message - send a message to a Claude session
  // Uses persistent processes to keep Anthropic prompt-cache warm.
  use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const { sessionId, message, images, cwd, permissions, model } = JSON.parse(body)

        if (!sessionId || (!message && (!images || images.length === 0))) {
          res.statusCode = 400
          res.end(
            JSON.stringify({ error: "sessionId and message or images are required" })
          )
          return
        }

        // Build permission args from config (falls back to YOLO)
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

        // Build the stream-json user message (works for text and images)
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

        // ── Try to reuse a persistent process ──────────────────────
        const existing = persistentSessions.get(sessionId)
        if (existing && !existing.dead) {
          // Persistent process is alive -- send message to its stdin
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

          // If the process dies while waiting, respond with error
          const onDeath = () => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            existing.onResult = null
            res.statusCode = 500
            res.end(JSON.stringify({ error: "Claude process died unexpectedly" }))
          }
          existing.proc.once("close", onDeath)

          existing.proc.stdin!.write(streamMsg + "\n")
          return
        }

        // ── Spawn a new persistent process ─────────────────────────
        // Clean up stale entry if any
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
          ],
          {
            cwd: cwd || homedir(),
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
          }
        )

        const ps: PersistentSession = {
          proc: child,
          onResult: null,
          dead: false,
          cwd: cwd || homedir(),
          permArgs,
          modelArgs,
          jsonlPath: null,
        }
        persistentSessions.set(sessionId, ps)
        activeProcesses.set(sessionId, child)

        // Resolve JSONL path asynchronously so we can forward progress events
        findJsonlPath(sessionId).then((p) => { ps.jsonlPath = p })

        // Read stdout line-by-line for result messages and progress forwarding
        const rl = createInterface({ input: child.stdout! })
        rl.on("line", (line) => {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === "result" && ps.onResult) {
              ps.onResult(parsed)
            }
            if (ps.jsonlPath && parsed.type === "progress") {
              appendFile(ps.jsonlPath, line + "\n").catch(() => {})
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
          activeProcesses.delete(sessionId)
          persistentSessions.delete(sessionId)
          if (ps.onResult) {
            ps.onResult({ type: "result", is_error: true, result: friendlySpawnError(err) })
          }
        })

        // Wire up result handler for this first message
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

        // Send the first message
        child.stdin!.write(streamMsg + "\n")
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Invalid JSON body" }))
      }
    })
  })
}
