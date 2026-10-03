import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { spawn as nodePtySpawn } from "node-pty"

/** The node-pty surface the PTY server drives; Bun's terminal is bridged to it. */
export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySpawnOptions {
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

interface BunTerminal {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

interface BunSubprocess {
  readonly pid: number
  readonly exited: Promise<number>
  kill(signal: string): void
}

/** The slice of Bun's global this module needs; the repo carries no Bun types. */
export interface BunTerminalRuntime {
  Terminal: new (options: {
    cols: number
    rows: number
    data: (terminal: BunTerminal, chunk: Uint8Array) => void
  }) => BunTerminal
  spawn(
    command: string[],
    options: { cwd: string; env: Record<string, string>; terminal: BunTerminal },
  ): BunSubprocess
}

/**
 * Bun cannot host node-pty: it closes the PTY master right after the fork, so
 * every shell gets SIGHUP within milliseconds (oven-sh/bun#7362). Bun 1.3.5+
 * ships its own PTY as Bun.Terminal, which is POSIX-only.
 */
export function bunTerminalRuntime(globalObject: object = globalThis): BunTerminalRuntime | null {
  if (process.platform === "win32") return null
  const bun = (globalObject as { Bun?: Partial<BunTerminalRuntime> }).Bun
  return typeof bun?.Terminal === "function" && typeof bun.spawn === "function"
    ? (bun as BunTerminalRuntime)
    : null
}

export function spawnPty(
  command: string,
  args: string[],
  options: PtySpawnOptions,
  runtime: BunTerminalRuntime | null = bunTerminalRuntime(),
): PtyProcess {
  if (!runtime) return nodePtySpawn(command, args, { name: "xterm-256color", ...options })
  return spawnBunTerminal(runtime, command, args, options)
}

/**
 * Bun.spawn leaves the child inside Bun's own session, so the PTY never becomes
 * its controlling terminal: no job control, and Ctrl-C never reaches the
 * foreground command. Starting the shell as a session leader that owns the
 * terminal fixes both: util-linux's setsid on Linux, and on macOS, which has no
 * setsid command, the system perl calling setsid(2) and TIOCSCTTY before exec.
 */
const MACOS_SESSION_LEADER = "use POSIX (); POSIX::setsid(); ioctl(STDIN, 0x20007461, 0); exec { $ARGV[0] } @ARGV"

function jobControlPrefix(): string[] {
  if (process.platform === "linux") return onPath("setsid") ? ["setsid", "--ctty", "--wait"] : []
  if (process.platform === "darwin") return onPath("perl") ? ["perl", "-e", MACOS_SESSION_LEADER] : []
  return []
}

function onPath(command: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

function spawnBunTerminal(
  bun: BunTerminalRuntime,
  command: string,
  args: string[],
  options: PtySpawnOptions,
): PtyProcess {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  const decoder = new TextDecoder()
  const terminal = new bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    data(_terminal, chunk) {
      const text = decoder.decode(chunk, { stream: true })
      if (!text) return
      for (const listener of dataListeners) listener(text)
    },
  })

  let subprocess: BunSubprocess
  try {
    subprocess = bun.spawn([...jobControlPrefix(), command, ...args], {
      cwd: options.cwd,
      env: options.env,
      terminal,
    })
  } catch (err) {
    terminal.close()
    throw err
  }

  void subprocess.exited.then((exitCode) => {
    terminal.close()
    for (const listener of exitListeners) listener({ exitCode })
  })

  return {
    pid: subprocess.pid,
    onData: (listener) => { dataListeners.push(listener) },
    onExit: (listener) => { exitListeners.push(listener) },
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: () => subprocess.kill("SIGHUP"),
  }
}
