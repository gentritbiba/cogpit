import { execFile } from "node:child_process"
import { isAbsolute, join } from "node:path"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { sendJson, type UseFn } from "../http"

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

export interface McpServerConfig {
  [name: string]: Record<string, unknown>
}

/**
 * Read all MCP server configs from global settings, project .mcp.json, and project .claude/settings.local.json.
 * Returns a merged map of server name → config object.
 */
async function readMcpConfigs(cwd: string): Promise<McpServerConfig> {
  const configs: McpServerConfig = {}

  // 1. ~/.claude.json — global + project-scoped servers from `claude mcp add`
  try {
    const raw = await readFile(join(homedir(), ".claude.json"), "utf-8")
    const parsed = JSON.parse(raw)
    // Global mcpServers
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      Object.assign(configs, parsed.mcpServers)
    }
    // Project-scoped mcpServers (stored under projects.<path>.mcpServers)
    if (parsed.projects && typeof parsed.projects === "object") {
      for (const [projPath, projConfig] of Object.entries(parsed.projects)) {
        if ((cwd === projPath || cwd.startsWith(projPath + "/")) && projConfig && typeof projConfig === "object") {
          const pc = projConfig as Record<string, unknown>
          if (pc.mcpServers && typeof pc.mcpServers === "object") {
            Object.assign(configs, pc.mcpServers as McpServerConfig)
          }
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Other standard config files
  const otherSources = [
    join(homedir(), ".claude", "settings.json"),    // global settings
    join(cwd, ".mcp.json"),                         // project
    join(cwd, ".claude", "settings.local.json"),    // project local
  ]
  for (const path of otherSources) {
    try {
      const raw = await readFile(path, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        Object.assign(configs, parsed.mcpServers)
      }
    } catch { /* ignore */ }
  }

  return configs
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
const cache = new Map<string, { servers: McpServer[]; configs: McpServerConfig; timestamp: number }>()

export function clearMcpCache(cwd?: string) {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}

export async function getMcpServers(cwd: string): Promise<{ servers: McpServer[]; configs: McpServerConfig }> {
  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { servers: cached.servers, configs: cached.configs }
  }

  const configs = await readMcpConfigs(cwd)

  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.CLAUDECODE
    execFile("claude", ["mcp", "list"], { cwd, env, timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ servers: cached?.servers ?? [], configs })
        return
      }
      const servers = parseMcpListOutput(stdout)
      cache.set(cwd, { servers, configs, timestamp: Date.now() })
      resolve({ servers, configs })
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

    if (!cwd || !isAbsolute(cwd)) {
      return sendJson(res, 400, { error: "cwd must be an absolute path" })
    }

    if (refresh) clearMcpCache(cwd)

    getMcpServers(cwd).then(({ servers, configs }) => {
      sendJson(res, 200, { servers, configs })
    }).catch(() => {
      sendJson(res, 500, { error: "Failed to fetch MCP servers" })
    })
  })
}
