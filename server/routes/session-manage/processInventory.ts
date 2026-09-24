import type { ChildProcess } from "node:child_process"
import type { IncomingMessage } from "node:http"
import type { UseFn } from "../../http"
import { sendJson } from "../../http"
import { mayActHostWide, filterVisible, type WithAccess } from "../../edition"
import { requestScope } from "../requestScope"
import { activeProcesses, persistentSessions, spawn } from "../../helpers"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import {
  allDescriptors,
  matchesAgentProcess,
  windowsProcessNameFilter,
  type AgentDescriptor,
  type AgentKind,
} from "../../../shared/session/agent-descriptors"

export interface AgentProcessInfo {
  pid: number
  memMB: number
  cpu: number
  sessionId: string | null
  agentKind: AgentKind
  managed: boolean
  tty: string
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

/**
 * Agents in classification order: an exact executable match is authoritative
 * and must not be pre-empted by another agent's loose substring match.
 */
const PROCESS_DESCRIPTORS: readonly AgentDescriptor[] = [...allDescriptors()].sort(
  (a, b) => Number(b.cli.process.by === "executable") - Number(a.cli.process.by === "executable"),
)

/** The agent a command line belongs to, or null for an unrelated process. */
function classifyProcess(command: string): AgentDescriptor | null {
  return PROCESS_DESCRIPTORS.find((descriptor) => matchesAgentProcess(descriptor, command)) ?? null
}

/**
 * The classified agent's own argv shape first, then any other's: a launcher
 * that wraps one CLI under another's name still carries a session id.
 */
function findSessionId(
  descriptor: AgentDescriptor,
  command: string,
  pid: number,
  trackedByPid: ReadonlyMap<number, string>,
): string | null {
  return trackedByPid.get(pid)
    ?? descriptor.cli.process.sessionIdFromCommand(command)
    ?? PROCESS_DESCRIPTORS
      .map((candidate) => candidate.cli.process.sessionIdFromCommand(command))
      .find((sessionId) => sessionId !== null)
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
      const descriptor = classifyProcess(command)
      if (!descriptor) continue

      const pid = item.ProcessId
      processes.push({
        pid,
        memMB: Math.round((item.WorkingSetSize || 0) / 1024 / 1024),
        cpu: 0,
        sessionId: findSessionId(descriptor, command, pid, trackedByPid),
        agentKind: descriptor.kind,
        managed: trackedByPid.has(pid),
        tty: "??",
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
    if (line.includes("grep")
      || line.includes("node ")
      || line.includes("esbuild")
      || line.includes("/bin/zsh")) {
      continue
    }

    const columns = line.trim().split(/\s+/)
    if (columns.length < 11) continue

    const pid = Number.parseInt(columns[1], 10)
    const args = columns.slice(10).join(" ")
    const descriptor = classifyProcess(args)
    if (!descriptor) continue

    processes.push({
      pid,
      memMB: Math.round((Number.parseInt(columns[5], 10) || 0) / 1024),
      cpu: Number.parseFloat(columns[2]) || 0,
      sessionId: findSessionId(descriptor, args, pid, trackedByPid),
      agentKind: descriptor.kind,
      managed: trackedByPid.has(pid),
      tty: columns[6] || "??",
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

function claimsSession(agentProcess: AgentProcessInfo): agentProcess is AgentProcessInfo & { sessionId: string } {
  return agentProcess.sessionId !== null
}

/**
 * The processes of sessions the caller may see in the scope the request asks
 * for, each with its `access` where the edition checks access, in the order
 * given. A process no session claims is a host resource, which only whoever
 * may act host-wide sees, and only unscoped.
 */
async function visibleProcesses(
  req: IncomingMessage,
  processes: readonly AgentProcessInfo[],
): Promise<Array<WithAccess<AgentProcessInfo>>> {
  const scope = requestScope(req)
  const seesHost = scope === "all" && mayActHostWide(req)
  const visible = await filterVisible(req, processes.filter(claimsSession), ({ sessionId }) => ({ sessionId }), scope)
  const visibleByPid = new Map(visible.map((agentProcess) => [agentProcess.pid, agentProcess]))
  return processes.flatMap((agentProcess) => {
    if (!claimsSession(agentProcess)) return seesHost ? [agentProcess] : []
    const shown = visibleByPid.get(agentProcess.pid)
    return shown ? [shown] : []
  })
}

export function registerRunningProcessesRoute(use: UseFn): void {
  use("/api/running-processes", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname.split("/").filter(Boolean).length > 0) return next()

    const isWindows = process.platform === "win32"
    const nameFilter = allDescriptors().map(windowsProcessNameFilter).join(" or ")
    const child: ChildProcess = isWindows
      ? spawn("powershell", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "${nameFilter}" | Select-Object ProcessId, WorkingSetSize, CommandLine | ConvertTo-Json -Compress`,
        ])
      : spawn("ps", ["aux"])
    let stdout = ""
    let responded = false

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString() })
    const fail = () => sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Failed to list processes"))
    child.on("close", () => {
      if (responded) return
      responded = true
      const processes = parseAgentProcessOutput(stdout, process.platform, createTrackedSessionMap())
      void visibleProcesses(req, processes).then((visible) => sendJson(res, 200, visible), fail)
    })
    child.on("error", () => {
      if (responded) return
      responded = true
      fail()
    })
  })
}
