/**
 * Lifecycle of the agent-browser daemons behind Cogpit's named and throwaway
 * browsers. Each daemon writes `<runDir>/<name>.pid` and `.sock`; Chromium
 * writes `<profile>/DevToolsActivePort`, which goes stale after `close`, so a
 * browser only counts as running when the pid is alive *and* CDP answers.
 */
import { execFileSync, spawn as spawnProcess } from "node:child_process"
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { request } from "node:http"
import { basename, join } from "node:path"

import { resolveNavigationUrl } from "../../shared/browser/url"
import {
  assertBrowserName,
  assertNamedBrowser,
  isThrowawayName,
  isValidBrowserName,
  isValidCogpitSessionId,
  profileDir,
  runRoot,
  SHARED_RUN_NAME,
  sharedRunDir,
  shimPath,
} from "./paths"

export interface DaemonDeps {
  spawn: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stderr: string }>
  probe: (port: number) => Promise<boolean>
  kill: (pid: number, signal: NodeJS.Signals) => boolean
  isPidAlive: (pid: number) => boolean
}

export interface DevToolsEndpoint {
  port: number
  browserWsUrl: string
}

const PROBE_TIMEOUT_MS = 500
const DEVTOOLS_PORT_FILE = "DevToolsActivePort"
const PID_SUFFIX = ".pid"
const MAX_PORT = 65535
/** An unparsable pid file younger than this may still be mid-write by a starting daemon. */
const STALE_PID_FILE_MS = 60_000
const DAEMON_COMMAND_MARKER = "agent-browser"

function spawnCollectingStderr(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { env, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }))
  })
}

function probeDevTools(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/json/version", method: "GET", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(false))
    req.end()
  })
}

/** Guards against a recycled pid: only ever signal a process that is an agent-browser daemon. */
function isDaemonProcess(pid: number): boolean {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).includes(DAEMON_COMMAND_MARKER)
  } catch {
    return false
  }
}

function killPid(pid: number, signal: NodeJS.Signals): boolean {
  if (!isDaemonProcess(pid)) return false
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

export const defaultDaemonDeps: DaemonDeps = {
  spawn: spawnCollectingStderr,
  probe: probeDevTools,
  kill: killPid,
  isPidAlive,
}

function parsePositiveInt(raw: string): number | null {
  const text = raw.trim()
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : null
}

function parsePort(raw: string): number | null {
  const port = parsePositiveInt(raw)
  return port !== null && port <= MAX_PORT ? port : null
}

function readPidFile(path: string): number | null {
  try {
    return parsePositiveInt(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function isStaleFile(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_PID_FILE_MS
  } catch {
    return false
  }
}

interface PidFile {
  name: string
  path: string
  pid: number | null
}

function listPidFiles(dir: string): PidFile[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith(PID_SUFFIX))
    .map((entry) => {
      const path = join(dir, entry)
      return { name: basename(entry, PID_SUFFIX), path, pid: readPidFile(path) }
    })
}

function listRunSubdirs(): string[] {
  try {
    return readdirSync(runRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== SHARED_RUN_NAME)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function removeRunFiles(dir: string, name: string): void {
  rmSync(join(dir, `${name}${PID_SUFFIX}`), { force: true })
  rmSync(join(dir, `${name}.sock`), { force: true })
}

/** The shim stamps `.driver` from COGPIT_SESSION_ID, so the server's own value must never leak through. */
function shimEnv(cogpitSessionId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.COGPIT_SESSION_ID
  if (cogpitSessionId !== undefined) env.COGPIT_SESSION_ID = cogpitSessionId
  return env
}

function runShim(args: string[], env: NodeJS.ProcessEnv, deps: DaemonDeps): Promise<{ code: number; stderr: string }> {
  return deps.spawn(shimPath(), args, env)
}

export function readDevToolsEndpoint(name: string): DevToolsEndpoint | null {
  assertNamedBrowser(name)
  let raw: string
  try {
    raw = readFileSync(join(profileDir(name), DEVTOOLS_PORT_FILE), "utf8")
  } catch {
    return null
  }
  const [portLine = "", path = ""] = raw.split(/\r?\n/)
  const port = parsePort(portLine)
  if (port === null || !path.startsWith("/")) return null
  return { port, browserWsUrl: `ws://127.0.0.1:${port}${path}` }
}

export function readDaemonPid(name: string, runDir = sharedRunDir()): number | null {
  assertBrowserName(name)
  return readPidFile(join(runDir, `${name}${PID_SUFFIX}`))
}

export async function isRunning(name: string, deps = defaultDaemonDeps): Promise<boolean> {
  assertNamedBrowser(name)
  const pid = readDaemonPid(name)
  if (pid === null || !deps.isPidAlive(pid)) return false
  const endpoint = readDevToolsEndpoint(name)
  return endpoint !== null && deps.probe(endpoint.port)
}

/**
 * The one door to a real Chromium: the viewer socket and the REST route both
 * land here, so the scheme allow-list lives here rather than at each of them —
 * a `file:` or `chrome:` url must never reach the shim.
 */
export async function launch(name: string, url: string, cogpitSessionId?: string, deps = defaultDaemonDeps): Promise<void> {
  assertNamedBrowser(name)
  if (url.startsWith("-")) throw new Error(`Browser url ${JSON.stringify(url)} must not start with "-"`)
  const target = resolveNavigationUrl(url)
  const { code, stderr } = await runShim(["--session", name, "open", target], shimEnv(cogpitSessionId), deps)
  if (code !== 0) throw new Error(`agent-browser failed (${code}): ${stderr.trim()}`)
}

/** `close` goes through the shim, which would spawn a fresh daemon if none is alive, so it only runs against a live pid. */
export async function stop(name: string, deps = defaultDaemonDeps): Promise<void> {
  assertNamedBrowser(name)
  const pid = readDaemonPid(name)
  if (pid !== null && deps.isPidAlive(pid)) {
    await runShim(["--session", name, "close"], shimEnv(), deps).catch(() => undefined)
    deps.kill(pid, "SIGTERM")
  }
  removeRunFiles(sharedRunDir(), name)
}

export function reapRunDir(dir: string, deps = defaultDaemonDeps): void {
  for (const { pid } of listPidFiles(dir)) {
    if (pid !== null) deps.kill(pid, "SIGTERM")
  }
  rmSync(dir, { recursive: true, force: true })
}

export function sweep(isCogpitSessionLive: (id: string) => boolean, deps = defaultDaemonDeps): void {
  for (const { name, path, pid } of listPidFiles(sharedRunDir())) {
    const dead = pid === null ? isStaleFile(path) : !deps.isPidAlive(pid)
    if (dead) removeRunFiles(sharedRunDir(), name)
  }
  for (const dir of listRunSubdirs()) {
    if (!isValidCogpitSessionId(dir) || !isCogpitSessionLive(dir)) reapRunDir(join(runRoot(), dir), deps)
  }
}

export async function shutdownBrowsers(deps = defaultDaemonDeps): Promise<void> {
  for (const dir of listRunSubdirs()) reapRunDir(join(runRoot(), dir), deps)
  await Promise.all(
    listPidFiles(sharedRunDir()).map(async ({ name, pid }) => {
      if (isValidBrowserName(name) && !isThrowawayName(name)) {
        await stop(name, deps).catch(() => undefined)
        return
      }
      if (pid !== null) deps.kill(pid, "SIGTERM")
      removeRunFiles(sharedRunDir(), name)
    }),
  )
}

export function startSweeper(
  isCogpitSessionLive: (id: string) => boolean,
  intervalMs = 60_000,
  deps = defaultDaemonDeps,
): () => void {
  const run = () => {
    try {
      sweep(isCogpitSessionLive, deps)
    } catch {
      // a failed sweep is retried on the next tick
    }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
