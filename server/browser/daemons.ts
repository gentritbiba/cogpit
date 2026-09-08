/**
 * Lifecycle of the agent-browser daemons behind Cogpit's named and throwaway
 * browsers. Each daemon writes `<runDir>/<name>.pid` and `.sock` (`.port` on
 * Windows, where it listens on loopback TCP); Chromium writes
 * `<profile>/DevToolsActivePort`, which goes stale after `close`, so a browser
 * only counts as running when the pid is alive *and* CDP answers.
 */
import { execFileSync, spawn as spawnProcess } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { basename, join } from "node:path"

import { resolveNavigationUrl } from "../../shared/browser/url"
import { resolveAgentCommand } from "../lib/binaryResolver"
import {
  assertBrowserName,
  assertNamedBrowser,
  browserHome,
  isThrowawayName,
  isValidBrowserName,
  isValidCogpitSessionId,
  profileDir,
  runRoot,
  SHARED_RUN_NAME,
  sharedRunDir,
  shimPath,
  sweepOwnerFile,
} from "./paths"
import { processCommandLine, terminateProcess } from "./processControl"

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
/** A shim call that has not returned by now is wedged; nothing here waits on a user. */
const SHIM_TIMEOUT_MS = 30_000
/** Matches `processRegistry`: SIGTERM, this long to exit, then SIGKILL. */
const TERMINATION_GRACE_MS = 3_000
const EXIT_POLL_MS = 100
/** App quit waits on this and no longer; a wedged daemon must not hold the window open. */
const SHUTDOWN_TIMEOUT_MS = 15_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** The shim is a batch file on Windows, which only cmd.exe can run. */
function spawnCollectingStderr(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
  const cli = resolveAgentCommand(command, args, { env })
  return new Promise((resolve, reject) => {
    const child = spawnProcess(cli.command, cli.args, { env, stdio: ["ignore", "ignore", "pipe"], ...cli.spawnOptions })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // A daemon that never answers would otherwise hold this promise — and the
    // shutdown awaiting it — open for the life of the process.
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${command} did not finish in ${SHIM_TIMEOUT_MS / 1_000}s`))
    }, SHIM_TIMEOUT_MS)
    timer.unref?.()
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stderr })
    })
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

function runQuietly(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

/** Guards against a recycled pid: only ever signal a process that is an agent-browser daemon. */
function isDaemonProcess(pid: number): boolean {
  return processCommandLine(pid, process.platform, runQuietly).includes(DAEMON_COMMAND_MARKER)
}

function killPid(pid: number, signal: NodeJS.Signals): boolean {
  if (!isDaemonProcess(pid)) return false
  try {
    terminateProcess(pid, signal, process.platform, runQuietly)
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
  for (const suffix of [PID_SUFFIX, ".sock", ".port"]) rmSync(join(dir, `${name}${suffix}`), { force: true })
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

/**
 * SIGTERM, then SIGKILL for a daemon that will not go. `deps.kill` keeps its
 * `ps` guard on both signals, so a recycled pid is never the one that dies.
 */
async function terminateDaemon(pid: number, deps: DaemonDeps): Promise<void> {
  deps.kill(pid, "SIGTERM")
  for (let waited = 0; waited < TERMINATION_GRACE_MS; waited += EXIT_POLL_MS) {
    if (!deps.isPidAlive(pid)) return
    await delay(EXIT_POLL_MS)
  }
  if (deps.isPidAlive(pid)) deps.kill(pid, "SIGKILL")
}

/** `close` goes through the shim, which would spawn a fresh daemon if none is alive, so it only runs against a live pid. */
export async function stop(name: string, deps = defaultDaemonDeps): Promise<void> {
  assertNamedBrowser(name)
  const pid = readDaemonPid(name)
  if (pid !== null && deps.isPidAlive(pid)) {
    await runShim(["--session", name, "close"], shimEnv(), deps).catch(() => undefined)
    await terminateDaemon(pid, deps)
  }
  removeRunFiles(sharedRunDir(), name)
}

/**
 * Which Cogpit owns this browser tree.
 *
 * `run/<id>` names a session only the process that started it knows about, so a
 * second Cogpit reading the same tree — the Vite dev server beside the packaged
 * app is the normal case — sees every one of them as finished and reaps a live
 * subagent's browser. Reaping is therefore single-owner: a file names the
 * holder, and only a holder whose process is gone may be taken over.
 */
interface SweepOwner {
  pid: number
  startedAt: number
}

/** Distinguishes us from a later process that happens to reuse our pid. */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1_000)

function readOwner(): SweepOwner | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(sweepOwnerFile(), "utf8"))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const { pid, startedAt } = parsed as Partial<SweepOwner>
  return typeof pid === "number" && typeof startedAt === "number" ? { pid, startedAt } : null
}

/** True when this process is the one named in the owner file. */
export function holdsSweepOwnership(): boolean {
  const owner = readOwner()
  return owner !== null && owner.pid === process.pid && owner.startedAt === PROCESS_STARTED_AT
}

export function acquireSweepOwnership(deps = defaultDaemonDeps): boolean {
  if (holdsSweepOwnership()) return true
  const owner = readOwner()
  if (owner !== null && deps.isPidAlive(owner.pid)) return false
  const path = sweepOwnerFile()
  const tmp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(browserHome(), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, startedAt: PROCESS_STARTED_AT })}\n`)
    renameSync(tmp, path)
  } catch {
    rmSync(tmp, { force: true })
    return false
  }
  // Two instances can reach the rename together; the file says which one landed last.
  return holdsSweepOwnership()
}

function releaseSweepOwnership(): void {
  if (holdsSweepOwnership()) rmSync(sweepOwnerFile(), { force: true })
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

async function shutdownAll(deps: DaemonDeps): Promise<void> {
  // Throwaway trees are scratch space with no user state in them, so they go
  // with whoever is quitting. Named browsers hold the user's logins and are
  // shared with any other Cogpit here: only their owner may stop them.
  for (const dir of listRunSubdirs()) reapRunDir(join(runRoot(), dir), deps)
  if (!holdsSweepOwnership()) return
  await Promise.all(
    listPidFiles(sharedRunDir()).map(async ({ name, pid }) => {
      if (isValidBrowserName(name) && !isThrowawayName(name)) {
        await stop(name, deps).catch(() => undefined)
        return
      }
      if (pid !== null) await terminateDaemon(pid, deps)
      removeRunFiles(sharedRunDir(), name)
    }),
  )
  releaseSweepOwnership()
}

export function shutdownBrowsers(deps = defaultDaemonDeps): Promise<void> {
  return withTimeout(
    shutdownAll(deps),
    SHUTDOWN_TIMEOUT_MS,
    `The browser daemons did not stop in ${SHUTDOWN_TIMEOUT_MS / 1_000}s`,
  )
}

export function startSweeper(
  isCogpitSessionLive: (id: string) => boolean,
  intervalMs = 60_000,
  deps = defaultDaemonDeps,
): () => void {
  const run = () => {
    try {
      if (acquireSweepOwnership(deps)) sweep(isCogpitSessionLive, deps)
    } catch {
      // a failed sweep is retried on the next tick
    }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
