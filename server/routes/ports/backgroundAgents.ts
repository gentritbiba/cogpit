import { readlink } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { dirs } from "../../helpers"
import type { NextFn } from "../../http"
import {
  handleBackgroundOutputCollection,
  readBackgroundOutputPrefix,
} from "./backgroundOutputs"

export async function handleBackgroundAgents(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): Promise<void> {
  return handleBackgroundOutputCollection(req, res, next, async (files) => {
    const agents: Array<{
      agentId: string
      dirName: string
      fileName: string
      parentSessionId: string
      modifiedAt: number
      isActive: boolean
      preview: string
    }> = []

    for (const file of files) {
      // Only process symlinks (background agents), skip regular files (bash tasks)
      if (!file.isSymbolicLink) continue

      const agentId = file.fileName.replace(".output", "")

      let targetPath: string
      try {
        targetPath = await readlink(file.path)
      } catch { continue }

      // Parse the target path to extract dirName and fileName
      // Target format: {PROJECTS_DIR}/{dirName}/{parentSessionId}/subagents/agent-{agentId}.jsonl
      if (!targetPath.startsWith(dirs.PROJECTS_DIR)) continue

      const relativePath = targetPath.slice(dirs.PROJECTS_DIR.length).replace(/^\//, "")
      const parts = relativePath.split("/")
      // parts: [dirName, parentSessionId, "subagents", "agent-{agentId}.jsonl"]
      if (parts.length < 4 || parts[2] !== "subagents") continue

      const dirName = parts[0]
      const parentSessionId = parts[1]
      const fileName = `${parentSessionId}/subagents/${parts[3]}`

      const output = await readBackgroundOutputPrefix(targetPath, 4096)
      if (!output) continue

      const { modifiedAt } = output
      let preview = ""
      if (output.size > 0) {
        // Try to find the agent's task description from the first user message
        const lines = output.content.split("\n").filter((line) => line.trim())
        for (const line of lines.slice(0, 5)) {
          try {
            const msg = JSON.parse(line)
            if (msg.type === "user" && !msg.isMeta) {
              const content = msg.message?.content
              if (typeof content === "string") {
                preview = content.slice(0, 120)
                break
              } else if (Array.isArray(content)) {
                const textBlock = content.find((block: { type: string }) => block.type === "text")
                if (textBlock && typeof textBlock.text === "string") {
                  preview = textBlock.text.slice(0, 120)
                  break
                }
              }
            }
          } catch {
            continue
          }
        }
      }

      const isActive = Date.now() - modifiedAt < 60_000

      agents.push({ agentId, dirName, fileName, parentSessionId, modifiedAt, isActive, preview })
    }

    agents.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return agents
  })
}
