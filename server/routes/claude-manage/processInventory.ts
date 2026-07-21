import type { ChildProcess } from "node:child_process"
import type { UseFn } from "../../http"
import { sendJson } from "../../http"
import { activeProcesses, persistentSessions, spawn } from "../../helpers"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"

export interface AgentProcessInfo {
  pid: number
  memMB: number
  cpu: number
  sessionId: string | null
  agentKind: "claude" | "codex"
  tty: string
  args: string
  startTime: string
}

function createTrackedSessionMap(): Map<number, string> {
  const trackedByPid = new Map<number, string>()
  for (const [sessionId, session] of persistentSessions) {
    if (session.proc.pid) trackedByPid.set(session.proc.pid, sessionId)
  }
  for (const [sessionId, process] of activeProcesses) {
    if (process.pid && !trackedByPid.has(process.pid)) {
      trackedByPid.set(process.pid, sessionId)
    }
  }
  return trackedByPid
}

function findSessionId(
  command: string,
  pid: number,
  trackedByPid: ReadonlyMap<number, string>,
): string | null {
  const resumeMatch = command.match(/--resume\s+([0-9a-f-]{36})/)
  const sessionIdMatch = command.match(/--session-id\s+([0-9a-f-]{36})/)
  const codexResumeMatch = command.match(/codex(?:\s+\S+)*\s+exec\s+resume\s+([0-9a-f-]{36})/)
  return trackedByPid.get(pid)
    ?? resumeMatch?.[1]
    ?? sessionIdMatch?.[1]
    ?? codexResumeMatch?.[1]
    ?? null
}

function parseWindowsProcesses(
  stdout: string,
  trackedByPid: ReadonlyMap<number, string>,
): AgentProcessInfo[] {
  try {
    const parsed = JSON.parse(stdout)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    const processes: AgentProcessInfo[] = []

    for (const item of items) {
      const command = item?.CommandLine || ""
      if (!command.includes("claude") && !command.includes("codex")) continue

      const pid = item.ProcessId
      processes.push({
        pid,
        memMB: Math.round((item.WorkingSetSize || 0) / 1024 / 1024),
        cpu: 0,
        sessionId: findSessionId(command, pid, trackedByPid),
        agentKind: command.includes("codex") ? "codex" : "claude",
        tty: "??",
        args: command,
        startTime: "",
      })
    }

    return processes
  } catch {
    // PowerShell returns an empty string when no matching processes exist.
    return []
  }
}

function parsePosixProcesses(
  stdout: string,
  trackedByPid: ReadonlyMap<number, string>,
): AgentProcessInfo[] {
  const processes: AgentProcessInfo[] = []

  for (const line of stdout.split("\n")) {
    if ((!line.includes("claude") && !line.includes("codex"))
      || line.includes("grep")
      || line.includes("node ")
      || line.includes("esbuild")
      || line.includes("/bin/zsh")) {
      continue
    }

    const columns = line.trim().split(/\s+/)
    if (columns.length < 11) continue

    const pid = Number.parseInt(columns[1], 10)
    const args = columns.slice(10).join(" ")
    processes.push({
      pid,
      memMB: Math.round((Number.parseInt(columns[5], 10) || 0) / 1024),
      cpu: Number.parseFloat(columns[2]) || 0,
      sessionId: findSessionId(args, pid, trackedByPid),
      agentKind: args.includes("codex") ? "codex" : "claude",
      tty: columns[6] || "??",
      args,
      startTime: columns[8] || "",
    })
  }

  return processes
}

export function parseAgentProcessOutput(
  stdout: string,
  platform: NodeJS.Platform,
  trackedByPid: ReadonlyMap<number, string> = new Map(),
): AgentProcessInfo[] {
  const processes = platform === "win32"
    ? parseWindowsProcesses(stdout, trackedByPid)
    : parsePosixProcesses(stdout, trackedByPid)
  return processes.sort((left, right) => right.memMB - left.memMB)
}

export function registerRunningProcessesRoute(use: UseFn): void {
  use("/api/running-processes", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname.split("/").filter(Boolean).length > 0) return next()

    const isWindows = process.platform === "win32"
    const child: ChildProcess = isWindows
      ? spawn("powershell", [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"name like '%claude%' or name like '%codex%'\" | Select-Object ProcessId, WorkingSetSize, CommandLine | ConvertTo-Json -Compress",
        ])
      : spawn("ps", ["aux"])
    let stdout = ""
    let responded = false

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString() })
    child.on("close", () => {
      if (responded) return
      responded = true
      sendJson(res, 200, parseAgentProcessOutput(
        stdout,
        process.platform,
        createTrackedSessionMap(),
      ))
    })
    child.on("error", () => {
      if (responded) return
      responded = true
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Failed to list processes"))
    })
  })
}
