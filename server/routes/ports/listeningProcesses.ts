import { spawn } from "../../helpers"

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args)
    let stdout = ""
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
    })
    child.on("error", reject)
    child.on("close", () => resolve(stdout))
  })
}

/** PIDs of processes listening on a TCP port, newest-first is not guaranteed. */
export async function findListeningPids(port: number): Promise<number[]> {
  const stdout = process.platform === "win32"
    ? await runCapture("netstat", ["-ano", "-p", "tcp"])
    : await runCapture("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"])

  const pids = process.platform === "win32"
    ? parseNetstatPids(stdout, port)
    : stdout.trim().split("\n").map((line) => parseInt(line, 10))

  return [...new Set(pids.filter((pid) => pid > 0))]
}

/**
 * netstat rows look like:
 *   TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    1234
 * IPv6 local addresses are bracketed ([::]:3000), so match on the :port suffix.
 */
function parseNetstatPids(stdout: string, port: number): number[] {
  const suffix = `:${port}`
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) =>
      cols.length >= 5
      && cols[0].toUpperCase() === "TCP"
      && cols[1].endsWith(suffix)
      && cols[3].toUpperCase() === "LISTENING")
    .map((cols) => parseInt(cols[4], 10))
}

/**
 * Windows has no process groups and maps every signal to an unconditional
 * TerminateProcess, so a dev server's own children would survive process.kill.
 */
export async function killListeningProcess(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM")
    return
  }
  await runCapture("taskkill", ["/pid", String(pid), "/t", "/f"])
}
