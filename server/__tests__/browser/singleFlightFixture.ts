import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * A stand-in for the real binary that starts its "daemon" (a long sleep whose
 * pid it writes, as agent-browser writes its daemon's) only when none is up,
 * and slowly, the way a real start leaves a window for a second call. Every
 * start and every call is logged to $FLIGHT_LOG.
 */
export const SLOW_START_BINARY = [
  "#!/usr/bin/env bash",
  'pidfile="$AGENT_BROWSER_SOCKET_DIR/$FLIGHT_NAME.pid"',
  'if ! { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }; then',
  '  echo started >> "$FLIGHT_LOG"',
  "  sleep 0.4",
  "  sleep 60 >/dev/null 2>&1 &",
  '  echo "$!" > "$pidfile"',
  "fi",
  'echo ran >> "$FLIGHT_LOG"',
  "",
].join("\n")

/** Run `count` copies of `command args` at once and resolve with their exit codes. */
export function runAtOnce(command: string, args: string[], env: NodeJS.ProcessEnv, count: number): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore" })
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? -1))
  })))
}

/** How many times the log says `line`. */
export function logged(log: string, line: "started" | "ran"): number {
  return readFileSync(log, "utf8").split("\n").filter((entry) => entry === line).length
}

/** Stop the stand-in daemon a run left behind. */
export function stopFakeDaemon(pidFile: string): void {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL")
  } catch {
    // Never started, or already gone.
  }
}
