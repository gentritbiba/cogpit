import {
  dirs,
  isWithinDir,
  friendlySpawnError,
  activeProcesses,
  spawn,
  readdir,
  open,
  join,
  randomUUID,
  stat,
} from "../helpers"
import type { UseFn } from "../helpers"

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
}
