import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import type { RunningStandaloneServer } from "../../../server/standalone-runtime"

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface LaunchCommand {
  command: "launch"
  mode: "full" | "preview"
  sessionId?: string
  server?: string
  port: number
  dataDir?: string
  noOpen: boolean
}

export type ParsedArgs = LaunchCommand | { command: "help" }

export interface CliIo {
  stdout: { write: (text: string) => unknown }
  stderr: { write: (text: string) => unknown }
}

export interface CliDependencies {
  fetch: typeof fetch
  openUrl: (url: string) => Promise<void>
  startServer: (options: { port: number; dataDir?: string }) => Promise<RunningStandaloneServer>
  waitForShutdown: () => Promise<void>
  io: CliIo
}

export const USAGE = `Cogpit

Run Cogpit locally without installing it:
  cogpit [options]
  cogpit preview <session-id> [options]

Options:
  --port <number>  Bind a specific local port (default: automatic)
  --data-dir <dir> Store Cogpit configuration in a specific directory
  --server <url>   Open an already-running Cogpit server instead
  --no-open        Start the server without opening a browser
  -h, --help       Show this help
`

function parsePort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error("--port requires a number.")
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be between 0 and 65535.")
  }
  return port
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes("-h") || argv.includes("--help")) return { command: "help" }

  let mode: LaunchCommand["mode"] = "full"
  let sessionId: string | undefined
  let index = 0

  if (argv[0] === "preview") {
    mode = "preview"
    sessionId = argv[1]
    if (!sessionId || sessionId.startsWith("-")) {
      throw new Error("Usage: cogpit preview <session-id>")
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("Session ID contains unsupported characters.")
    }
    index = 2
  } else if (argv[0] && !argv[0].startsWith("-")) {
    throw new Error(`Unknown command: ${argv[0]}`)
  }

  let server: string | undefined
  let port = 0
  let portWasSet = false
  let dataDir: string | undefined
  let noOpen = false

  for (; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--no-open") {
      noOpen = true
      continue
    }
    if (value === "--server") {
      server = argv[index + 1]
      if (!server) throw new Error("--server requires a URL.")
      index += 1
      continue
    }
    if (value === "--port") {
      port = parsePort(argv[index + 1])
      portWasSet = true
      index += 1
      continue
    }
    if (value === "--data-dir") {
      const path = argv[index + 1]
      if (!path) throw new Error("--data-dir requires a directory.")
      dataDir = resolve(path)
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }

  if (server && portWasSet) throw new Error("--server and --port cannot be used together.")
  if (server && dataDir) throw new Error("--server and --data-dir cannot be used together.")

  return { command: "launch", mode, sessionId, server, port, dataDir, noOpen }
}

export function normalizeServerUrl(value: string): string {
  const parsed = new URL(value.includes("://") ? value : `http://${value}`)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Cogpit server must use http or https.")
  }
  if (parsed.username || parsed.password) {
    throw new Error("Cogpit server URL must not contain credentials.")
  }
  return parsed.origin
}

export function buildLaunchUrl(server: string, command: LaunchCommand): string {
  const origin = normalizeServerUrl(server)
  return command.mode === "preview"
    ? `${origin}/preview/${encodeURIComponent(command.sessionId!)}`
    : `${origin}/`
}

export async function openExternalUrl(url: string): Promise<void> {
  const target = process.platform === "darwin"
    ? { command: "open", args: [url] }
    : process.platform === "win32"
      ? { command: "cmd", args: ["/c", "start", "", url] }
      : { command: "xdg-open", args: [url] }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(target.command, target.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolvePromise()
    })
  })
}

async function startPackagedServer(
  options: { port: number; dataDir?: string },
): Promise<RunningStandaloneServer> {
  const { startStandaloneServer } = await import("../../../server/standalone-runtime")
  return startStandaloneServer({
    staticDir: join(import.meta.dirname, "web"),
    dataDir: options.dataDir ?? join(homedir(), ".config", "cogpit"),
    host: "127.0.0.1",
    port: options.port,
    publishPort: false,
  })
}

export async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const signals: NodeJS.Signals[] = process.platform === "win32"
      ? ["SIGINT", "SIGBREAK"]
      : ["SIGINT", "SIGTERM"]
    const done = () => {
      for (const signal of signals) process.off(signal, done)
      resolvePromise()
    }
    for (const signal of signals) process.once(signal, done)
  })
}

const defaultDependencies: CliDependencies = {
  fetch,
  openUrl: openExternalUrl,
  startServer: startPackagedServer,
  waitForShutdown: waitForShutdownSignal,
  io: { stdout: process.stdout, stderr: process.stderr },
}

async function verifyServer(
  server: string,
  command: LaunchCommand,
  deps: CliDependencies,
): Promise<void> {
  const hello = await deps.fetch(`${server}/api/hello`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  })
  if (!hello.ok) throw new Error(`Cogpit did not respond (${hello.status}).`)
  const identity = await hello.json() as { app?: string }
  if (identity.app !== "cogpit") throw new Error("The target server is not Cogpit.")

  if (command.mode === "preview") {
    const lookup = await deps.fetch(
      `${server}/api/find-session/${encodeURIComponent(command.sessionId!)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) },
    )
    if (lookup.status === 404) {
      throw new Error(`Session ${command.sessionId} was not found.`)
    }
    if (!lookup.ok) throw new Error(`Cogpit could not resolve the session (${lookup.status}).`)
  }
}

export async function run(
  argv: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps: CliDependencies = { ...defaultDependencies, ...overrides }
  let command: ParsedArgs
  try {
    command = parseArgs(argv)
  } catch (error) {
    deps.io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    deps.io.stderr.write("Run `cogpit --help` for usage.\n")
    return 1
  }

  if (command.command === "help") {
    deps.io.stdout.write(USAGE)
    return 0
  }

  if (command.server) {
    try {
      const server = normalizeServerUrl(command.server)
      await verifyServer(server, command, deps)
      const url = buildLaunchUrl(server, command)
      if (!command.noOpen) await deps.openUrl(url)
      deps.io.stdout.write(`${url}\n`)
      return 0
    } catch (error) {
      deps.io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  let runtime: RunningStandaloneServer
  try {
    runtime = await deps.startServer({ port: command.port, dataDir: command.dataDir })
  } catch (error) {
    deps.io.stderr.write(`Unable to start Cogpit: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  try {
    await verifyServer(runtime.url, command, deps)
    const url = buildLaunchUrl(runtime.url, command)
    if (!command.noOpen) await deps.openUrl(url)
    deps.io.stdout.write(`Cogpit is running at ${url}\n`)
    deps.io.stdout.write("Press Ctrl+C to stop.\n")
    await deps.waitForShutdown()
    return 0
  } catch (error) {
    deps.io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    await runtime.dispose()
  }
}
