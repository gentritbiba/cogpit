import { execFile } from "node:child_process"

import type {
  SystemProcessKind,
  SystemProcessMetric,
  SystemProcessesSnapshot,
} from "../../src/lib/performanceTypes"

/**
 * System-wide view of agent-related processes (Claude sessions, headless
 * browsers, agent tooling). Cogpit's own metrics only cover its process tree,
 * but macOS attributes energy from every descendant — and leaked descendants
 * (orphaned sessions, unclosed browsers) are exactly what drains the battery
 * while the in-app numbers look idle.
 */

export interface RawProcess {
  pid: number
  ppid: number
  cpuPercent: number
  rssKb: number
  etime: string
  command: string
}

const MAX_LISTED_PROCESSES = 20
const MAX_COMMAND_CHARS = 200
const HOT_BROWSER_CPU_PERCENT = 10
// A busy browser younger than this is likely mid-automation, not leaked.
const HOT_BROWSER_MIN_AGE_SECONDS = 30 * 60

export function parseEtimeSeconds(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!match) return 0
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  )
}

export function parsePsOutput(text: string): RawProcess[] {
  const rows: RawProcess[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*\S)/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssKb: Number(match[4]),
      etime: match[5],
      command: match[6],
    })
  }
  return rows
}

function classifyKind(command: string): SystemProcessKind | null {
  if (/Cogpit Helper|Cogpit\.app/.test(command)) return "cogpit"
  if (/chrome-headless-shell|headless_shell/.test(command)) return "headless-browser"
  if (/agent-browser\/(?:bin|dist)/.test(command)) return "browser-daemon"
  if (/(?:^|\/)claude(?:\s|$)|\.local\/share\/claude\/versions\//.test(command)) return "claude"
  if (
    /(?:^|\/)(?:bun|node)(?:\s|$)/.test(command) &&
    /scratchpad|\/tmp\/|\s-e\s/.test(command)
  ) {
    return "script"
  }
  return null
}

function labelFor(kind: SystemProcessKind, command: string): string {
  if (kind === "claude") return "Claude session"
  if (kind === "headless-browser") return "Headless Chrome"
  if (kind === "browser-daemon") return "agent-browser daemon"

  if (kind === "cogpit") {
    const helper = /Cogpit Helper(?: \((?:Renderer|GPU|Plugin)\))?/.exec(command)
    return helper ? helper[0] : "Cogpit"
  }

  // Scripts and shells: "<runtime> <script-basename>", e.g. "bun ua-echo.ts"
  const [executable, firstArg] = command.split(/\s+/)
  const runtime = executable.split("/").pop() ?? executable
  const script = firstArg && !firstArg.startsWith("-") ? firstArg.split("/").pop() : null
  return script ? `${runtime} ${script}` : runtime
}

function buildChildrenIndex(rows: RawProcess[]): Map<number, RawProcess[]> {
  const childrenOf = new Map<number, RawProcess[]>()
  for (const row of rows) {
    const siblings = childrenOf.get(row.ppid) ?? []
    siblings.push(row)
    childrenOf.set(row.ppid, siblings)
  }
  return childrenOf
}

export interface OrphanedClaudeSubtree {
  rootPid: number
  command: string
  ageSeconds: number
  /** Root pid plus every descendant it keeps alive */
  pids: number[]
}

/**
 * A claude session whose parent died (reparented to launchd) is a leak, and
 * so is everything it keeps alive underneath it. These are the only subtrees
 * safe to auto-reap: nothing can still be controlling them.
 */
export function collectOrphanedClaudeSubtrees(rows: RawProcess[]): OrphanedClaudeSubtree[] {
  const childrenOf = buildChildrenIndex(rows)
  const subtrees: OrphanedClaudeSubtree[] = []
  for (const row of rows) {
    if (row.ppid !== 1 || classifyKind(row.command) !== "claude") continue
    const pids: number[] = []
    const collect = (pid: number): void => {
      if (pids.includes(pid)) return
      pids.push(pid)
      for (const child of childrenOf.get(pid) ?? []) collect(child.pid)
    }
    collect(row.pid)
    subtrees.push({
      rootPid: row.pid,
      command: row.command,
      ageSeconds: parseEtimeSeconds(row.etime),
      pids,
    })
  }
  return subtrees
}

export function classifyProcesses(rows: RawProcess[], selfPid: number): SystemProcessMetric[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))

  const isDescendantOf = (row: RawProcess, ancestorPid: number): boolean => {
    let current: RawProcess | undefined = row
    for (let depth = 0; current && depth < 32; depth++) {
      if (current.pid === ancestorPid) return true
      current = byPid.get(current.ppid)
    }
    return false
  }

  const leakedSubtree = new Set<number>(
    collectOrphanedClaudeSubtrees(rows).flatMap((subtree) => subtree.pids),
  )

  const metrics: SystemProcessMetric[] = []
  for (const row of rows) {
    if (row.pid === selfPid) continue
    if (/(?:^|\/)ps(?:\s|$)/.test(row.command)) continue

    const inLeakedTree = leakedSubtree.has(row.pid)
    const kind = classifyKind(row.command) ??
      (inLeakedTree || isDescendantOf(row, selfPid) ? "other" : null)
    if (!kind) continue

    const ageSeconds = parseEtimeSeconds(row.etime)
    const orphaned = row.ppid === 1 && kind !== "cogpit" && kind !== "browser-daemon"
    const hotBrowser =
      (kind === "headless-browser" || kind === "browser-daemon") &&
      row.cpuPercent >= HOT_BROWSER_CPU_PERCENT &&
      ageSeconds >= HOT_BROWSER_MIN_AGE_SECONDS
    const suspectedLeak = inLeakedTree || hotBrowser || (kind === "script" && row.ppid === 1)

    metrics.push({
      pid: row.pid,
      kind,
      label: labelFor(kind, row.command),
      command: row.command.slice(0, MAX_COMMAND_CHARS),
      cpuPercent: row.cpuPercent,
      memoryMb: Math.round(row.rssKb / 1024),
      ageSeconds,
      orphaned,
      suspectedLeak,
    })
  }

  return metrics
    .sort((a, b) => {
      if (a.suspectedLeak !== b.suspectedLeak) return a.suspectedLeak ? -1 : 1
      return b.cpuPercent - a.cpuPercent || b.ageSeconds - a.ageSeconds
    })
    .slice(0, MAX_LISTED_PROCESSES)
}

export function listSystemProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,args="],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

export async function captureSystemProcesses(
  selfPid = process.pid,
): Promise<SystemProcessesSnapshot | undefined> {
  if (process.platform === "win32") return undefined
  const processes = classifyProcesses(parsePsOutput(await listSystemProcesses()), selfPid)
  return {
    capturedAt: Date.now(),
    processes,
    suspectedLeakCount: processes.filter((metric) => metric.suspectedLeak).length,
  }
}
