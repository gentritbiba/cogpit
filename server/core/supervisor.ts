import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"

import { resolveCoreBinary } from "./binary"
import { CORE_SECRET_HEADER, parseHandshake, type CoreConfig } from "./protocol"

/**
 * The one cogpit-core process this server talks to. Like `processRegistry`,
 * it is module state: every composition in the process (the Vite dev plugins,
 * Electron's worker, the standalone server, test fixtures) shares one core.
 * Each holds a lease; the first lease starts it and the last release stops it.
 */

const BOOT_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 2_000
const RESTART_BASE_DELAY_MS = 200
const RESTART_MAX_DELAY_MS = 10_000
/** A core that ran this long before crashing restarts from the shortest delay again. */
const STABLE_RUN_MS = 30_000
const STDERR_TAIL_LINES = 20

export interface CoreEndpoint {
  port: number
  secret: string
  version: string
  pid: number
  /** `http://127.0.0.1:<port>` */
  origin: string
}

export interface StartCoreOptions {
  /** The shell's packaged binary (`AppServerEnvironment.coreBin`). */
  coreBin?: string
  dataDir: string
}

export interface CoreLease {
  release(): Promise<void>
}

interface Running {
  child: ChildProcessWithoutNullStreams
  endpoint: CoreEndpoint
  startedAt: number
}

interface Waiter {
  resolve(endpoint: CoreEndpoint): void
  reject(error: Error): void
}

let leases = 0
let launchSpec: { binary: string; config: CoreConfig } | null = null
let running: Running | null = null
let restartAttempt = 0
let restartTimer: ReturnType<typeof setTimeout> | null = null
let waiters: Waiter[] = []
/** Serializes start and stop, so a release racing a new lease never strands either. */
let lifecycle: Promise<unknown> = Promise.resolve()

function serialized<T>(step: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(step, step)
  lifecycle = next.catch(() => undefined)
  return next
}

function unrefStreams(child: ChildProcessWithoutNullStreams): void {
  child.unref()
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    (stream as { unref?: () => void }).unref?.()
  }
}

function forwardStderr(child: ChildProcessWithoutNullStreams, tail: string[]): void {
  let partial = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    const lines = (partial + chunk).split(/\r?\n/)
    partial = lines.pop() ?? ""
    for (const line of lines) {
      if (!line) continue
      tail.push(line)
      if (tail.length > STDERR_TAIL_LINES) tail.shift()
      console.error(`[cogpit-core] ${line}`)
    }
  })
}

function readHandshakeLine(child: ChildProcessWithoutNullStreams, stderrTail: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = ""
    const fail = (reason: string) => {
      cleanup()
      const detail = stderrTail.length ? `\n${stderrTail.join("\n")}` : ""
      reject(new Error(`cogpit-core failed to start: ${reason}${detail}`))
    }
    const onData = (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline === -1) return
      cleanup()
      // Anything after the handshake is not ours to read; keep the pipe drained.
      child.stdout.resume()
      resolve(buffered.slice(0, newline).trim())
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      // stderr may still hold the reason; give it one turn to arrive.
      setImmediate(() => fail(`it exited (${signal ?? `code ${code}`}) before its handshake`))
    }
    const onError = (error: Error) => fail(error.message)
    const timer = setTimeout(() => fail(`no handshake within ${BOOT_TIMEOUT_MS} ms`), BOOT_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", onData)
    child.once("exit", onExit)
    child.once("error", onError)
  })
}

async function checkHealth(endpoint: CoreEndpoint): Promise<void> {
  const response = await fetch(`${endpoint.origin}/v1/health`, {
    headers: { [CORE_SECRET_HEADER]: endpoint.secret },
    signal: AbortSignal.timeout(BOOT_TIMEOUT_MS),
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error(`cogpit-core failed its health check (HTTP ${response.status})`)
}

function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS)
    child.once("exit", () => {
      clearTimeout(kill)
      resolve()
    })
    // Closing stdin is the core's signal to exit, on every platform.
    child.stdin.end()
  })
}

async function launch(binary: string, config: CoreConfig): Promise<Running> {
  const secret = randomBytes(32).toString("base64url")
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const stderrTail: string[] = []
  forwardStderr(child, stderrTail)
  // A core that dies before reading its boot line would otherwise raise EPIPE.
  child.stdin.on("error", () => undefined)
  child.stdin.write(`${JSON.stringify({ secret, config })}\n`)
  try {
    const handshake = parseHandshake(await readHandshakeLine(child, stderrTail))
    const endpoint: CoreEndpoint = {
      port: handshake.port,
      secret,
      version: handshake.version,
      pid: child.pid ?? 0,
      origin: `http://127.0.0.1:${handshake.port}`,
    }
    await checkHealth(endpoint)
    unrefStreams(child)
    return { child, endpoint, startedAt: Date.now() }
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }
}

function settleWaiters(result: { endpoint: CoreEndpoint } | { error: Error }): void {
  const pending = waiters
  waiters = []
  for (const waiter of pending) {
    if ("endpoint" in result) waiter.resolve(result.endpoint)
    else waiter.reject(result.error)
  }
}

function adopt(next: Running): void {
  const { child } = next
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (running !== next) return
    running = null
    if (leases === 0) return
    console.error(`[cogpit-core] exited unexpectedly (${signal ?? `code ${code}`}); restarting`)
    if (Date.now() - next.startedAt >= STABLE_RUN_MS) restartAttempt = 0
    scheduleRestart()
  }
  running = next
  // It may have died after answering its health check, before this listener.
  if (child.exitCode !== null || child.signalCode !== null) {
    onExit(child.exitCode, child.signalCode)
    return
  }
  child.once("exit", onExit)
  settleWaiters({ endpoint: next.endpoint })
}

function scheduleRestart(): void {
  const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** restartAttempt, RESTART_MAX_DELAY_MS)
  restartAttempt += 1
  restartTimer = setTimeout(() => {
    restartTimer = null
    void serialized(async () => {
      if (leases === 0 || running || !launchSpec) return
      try {
        adopt(await launch(launchSpec.binary, launchSpec.config))
      } catch (error) {
        console.error(`[cogpit-core] restart failed: ${error instanceof Error ? error.message : String(error)}`)
        if (leases > 0) scheduleRestart()
      }
    })
  }, delay)
  restartTimer.unref?.()
}

async function stop(): Promise<void> {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  restartAttempt = 0
  launchSpec = null
  settleWaiters({ error: new Error("cogpit-core stopped") })
  const current = running
  running = null
  if (current) await terminate(current.child)
}

/**
 * Take a lease on the core, starting it if this is the first. Rejects when the
 * binary is missing or fails to boot; there is no fallback implementation.
 * The core's config is process-wide, like the server's data root: a lease
 * taken while it runs shares the first lease's config.
 */
export function startCore({ coreBin, dataDir }: StartCoreOptions): Promise<CoreLease> {
  return serialized(async () => {
    const binary = resolveCoreBinary({ configured: coreBin })
    leases += 1
    if (!running && !launchSpec) {
      launchSpec = { binary, config: { dataDir } }
      try {
        adopt(await launch(binary, launchSpec.config))
      } catch (error) {
        leases -= 1
        launchSpec = null
        settleWaiters({ error: error instanceof Error ? error : new Error(String(error)) })
        throw error
      }
    }
    let released = false
    return {
      release: () => {
        if (released) return lifecycle.then(() => undefined)
        released = true
        return serialized(async () => {
          leases -= 1
          if (leases === 0) await stop()
        })
      },
    }
  })
}

/** The running core, or null while it is stopped or restarting. */
export function coreEndpoint(): CoreEndpoint | null {
  return running?.endpoint ?? null
}

/** The running core, waiting through a restart for at most `timeoutMs`. */
export function whenCoreReady(timeoutMs = BOOT_TIMEOUT_MS): Promise<CoreEndpoint> {
  if (running) return Promise.resolve(running.endpoint)
  if (leases === 0) return Promise.reject(new Error("cogpit-core is not running"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((waiter) => waiter !== entry)
      reject(new Error(`cogpit-core did not come back within ${timeoutMs} ms`))
    }, timeoutMs)
    const entry: Waiter = {
      resolve: (endpoint) => {
        clearTimeout(timer)
        resolve(endpoint)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    }
    waiters.push(entry)
  })
}
