import type { IncomingMessage, ServerResponse } from "node:http"
import {
  createConnection,
} from "../../helpers"
import type { NextFn } from "../../http"
import {
  handleBackgroundOutputCollection,
  readBackgroundOutputPrefix,
} from "./backgroundOutputs"

export async function handleBackgroundTasks(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  return handleBackgroundOutputCollection(req, res, next, async (files) => {
    const PORT_RE = /(?::(\d{4,5}))|(?:localhost:(\d{4,5}))|(?:port\s+(\d{4,5}))/gi
    const tasks: Array<{
      id: string
      outputPath: string
      ports: number[]
      preview: string
      modifiedAt: number
    }> = []

    for (const file of files) {
      // Skip symlinks (those are subagent tasks, not bash background tasks)
      if (file.isSymbolicLink) continue

      const taskId = file.fileName.replace(".output", "")

      const output = await readBackgroundOutputPrefix(file.path, 8192)
      if (!output || output.size === 0) continue // skip empty output files
      const { content, modifiedAt } = output

      const ports = new Set<number>()
      for (const m of content.matchAll(PORT_RE)) {
        const p = parseInt(m[1] || m[2] || m[3], 10)
        if (p > 0 && p < 65536) ports.add(p)
      }

      if (ports.size === 0) continue // skip tasks with no detected ports

      const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("[2K"))
      const preview = lines.slice(0, 5).join("\n").slice(0, 300)

      tasks.push({
        id: taskId,
        outputPath: file.path,
        ports: [...ports],
        preview,
        modifiedAt,
      })
    }

    const allPorts = [...new Set(tasks.flatMap((t) => t.ports))]
    const portAlive: Record<number, boolean> = {}
    await Promise.all(
      allPorts.map(
        (port) =>
          new Promise<void>((resolve) => {
            const socket = createConnection({ port, host: "127.0.0.1" })
            socket.setTimeout(500)
            socket.on("connect", () => { portAlive[port] = true; socket.destroy(); resolve() })
            socket.on("timeout", () => { portAlive[port] = false; socket.destroy(); resolve() })
            socket.on("error", () => { portAlive[port] = false; resolve() })
          })
      )
    )

    const portOwner = new Map<number, (typeof tasks)[0]>()
    for (const task of tasks) {
      for (const port of task.ports) {
        if (!portAlive[port]) continue
        const existing = portOwner.get(port)
        if (!existing || task.modifiedAt > existing.modifiedAt) {
          portOwner.set(port, task)
        }
      }
    }

    // Deduplicate tasks (a task may own multiple ports)
    const seen = new Set<string>()
    const result: Array<{
      id: string
      outputPath: string
      ports: number[]
      portStatus: Record<number, boolean>
      preview: string
    }> = []
    for (const task of portOwner.values()) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      const ps: Record<number, boolean> = {}
      for (const p of task.ports) ps[p] = !!portAlive[p]
      result.push({
        id: task.id,
        outputPath: task.outputPath,
        ports: task.ports,
        portStatus: ps,
        preview: task.preview,
      })
    }

    return result
  })
}
