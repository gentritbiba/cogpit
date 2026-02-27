import { readlink } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  stat,
  open,
  lstat,
  readdir,
  join,
  dirs,
} from "../../helpers"
import type { NextFn } from "../../helpers"

export async function handleBackgroundAgents(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  if (req.method !== "GET") return next()

  const url = new URL(req.url || "/", "http://localhost")
  const pathParts = url.pathname.split("/").filter(Boolean)
  if (pathParts.length > 0) return next()

  const cwd = url.searchParams.get("cwd")
  if (!cwd) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: "cwd query param required" }))
    return
  }

  try {
    const uid = process.getuid?.() ?? 501
    const tmpBase = `/private/tmp/claude-${uid}`

    const projectHash = cwd.replace(/\//g, "-").replace(/ /g, "-").replace(/@/g, "-").replace(/\./g, "-")
    const tasksDir = join(tmpBase, projectHash, "tasks")

    let files: string[]
    try {
      files = await readdir(tasksDir)
    } catch {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify([]))
      return
    }

    const agents: Array<{
      agentId: string
      dirName: string
      fileName: string
      parentSessionId: string
      modifiedAt: number
      isActive: boolean
      preview: string
    }> = []

    const projectsDir = dirs.PROJECTS_DIR

    for (const f of files) {
      if (!f.endsWith(".output")) continue
      const fullPath = join(tasksDir, f)

      // Only process symlinks (background agents), skip regular files (bash tasks)
      let isSymlink = false
      try {
        const lstats = await lstat(fullPath)
        isSymlink = lstats.isSymbolicLink()
      } catch { continue }

      if (!isSymlink) continue

      const agentId = f.replace(".output", "")

      // Resolve the symlink target
      let targetPath: string
      try {
        targetPath = await readlink(fullPath)
      } catch { continue }

      // Parse the target path to extract dirName and fileName
      // Target format: {PROJECTS_DIR}/{dirName}/{parentSessionId}/subagents/agent-{agentId}.jsonl
      if (!targetPath.startsWith(projectsDir)) continue

      const relativePath = targetPath.slice(projectsDir.length).replace(/^\//, "")
      const parts = relativePath.split("/")
      // parts: [dirName, parentSessionId, "subagents", "agent-{agentId}.jsonl"]
      if (parts.length < 4 || parts[2] !== "subagents") continue

      const dirName = parts[0]
      const parentSessionId = parts[1]
      const fileName = `${parentSessionId}/subagents/${parts[3]}`

      // Get modification time for activity status
      let modifiedAt = 0
      let preview = ""
      try {
        const s = await stat(targetPath)
        modifiedAt = s.mtimeMs

        // Read a small preview from the JSONL
        if (s.size > 0) {
          const fh = await open(targetPath, "r")
          try {
            const buf = Buffer.alloc(Math.min(s.size, 4096))
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
            const content = buf.subarray(0, bytesRead).toString("utf-8")
            // Try to find the agent's task description from the first user message
            const lines = content.split("\n").filter((l) => l.trim())
            for (const line of lines.slice(0, 5)) {
              try {
                const msg = JSON.parse(line)
                if (msg.type === "user" && !msg.isMeta) {
                  const content = msg.message?.content
                  if (typeof content === "string") {
                    preview = content.slice(0, 120)
                    break
                  } else if (Array.isArray(content)) {
                    const textBlock = content.find((b: { type: string }) => b.type === "text")
                    if (textBlock && typeof textBlock.text === "string") {
                      preview = textBlock.text.slice(0, 120)
                      break
                    }
                  }
                }
              } catch { continue }
            }
          } finally {
            await fh.close()
          }
        }
      } catch { continue }

      // Consider active if modified in the last 60 seconds
      const isActive = Date.now() - modifiedAt < 60_000

      agents.push({ agentId, dirName, fileName, parentSessionId, modifiedAt, isActive, preview })
    }

    // Sort by modification time, most recent first
    agents.sort((a, b) => b.modifiedAt - a.modifiedAt)

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(agents))
  } catch (err) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(err) }))
  }
}
