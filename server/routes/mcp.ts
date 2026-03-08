import { execFile } from "node:child_process"
import type { UseFn } from "../helpers"

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

/**
 * Parse the text output of `claude mcp list` into structured server entries.
 *
 * Actual output format (as of Claude CLI 2026):
 *   Checking MCP server health...
 *
 *   claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication
 *   next-devtools: npx -y next-devtools-mcp@latest - ✓ Connected
 *   clickup: npx -y mcp-remote https://mcp.clickup.com/mcp - ✓ Connected
 *
 * Each server line matches: `<name>: <command/url> - <status indicator> <status text>`
 */
export function parseMcpListOutput(output: string): McpServer[] {
  const servers: McpServer[] = []
  const lines = output.split("\n")
  for (const line of lines) {
    // Skip empty lines and the "Checking MCP server health..." header
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("Checking MCP")) continue

    // Match: "name: command/url - status"
    // The name is everything before the first ": "
    // The status is after the last " - "
    const colonIdx = trimmed.indexOf(": ")
    if (colonIdx === -1) continue

    const name = trimmed.slice(0, colonIdx)
    const rest = trimmed.slice(colonIdx + 2)

    // Find the status part after the last " - "
    const dashIdx = rest.lastIndexOf(" - ")
    if (dashIdx === -1) continue

    const rawStatus = rest.slice(dashIdx + 3).trim().toLowerCase()

    let status: McpServer["status"] = "error"
    if (rawStatus.includes("connected")) {
      status = "connected"
    } else if (rawStatus.includes("auth")) {
      status = "needs_auth"
    }

    servers.push({ name, status })
  }
  return servers
}

// ── Cache ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
const cache = new Map<string, { servers: McpServer[]; timestamp: number }>()

export function clearMcpCache(cwd?: string) {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}

export function getMcpServers(cwd: string): Promise<McpServer[]> {
  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return Promise.resolve(cached.servers)
  }

  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.CLAUDECODE
    execFile("claude", ["mcp", "list"], { cwd, env, timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve(cached?.servers ?? [])
        return
      }
      const servers = parseMcpListOutput(stdout)
      cache.set(cwd, { servers, timestamp: Date.now() })
      resolve(servers)
    })
  })
}

// ── Route ──────────────────────────────────────────────────────────────────
export function registerMcpRoutes(use: UseFn) {
  use("/api/mcp-servers", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "", `http://${req.headers.host}`)
    const cwd = url.searchParams.get("cwd")
    const refresh = url.searchParams.get("refresh") === "1"

    if (!cwd) {
      res.statusCode = 400
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: "cwd query parameter required" }))
      return
    }

    if (refresh) clearMcpCache(cwd)

    getMcpServers(cwd).then((servers) => {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ servers }))
    })
  })
}
