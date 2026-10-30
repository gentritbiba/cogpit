import { spawn, execFile } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

/** Commands with a bounded lifetime own a private process group, including their descendants. */
export async function runManagedCommand(options: {
  cwd: string
  file: string
  args: string[]
  timeoutMs: number
  signal: AbortSignal
  output: (text: string) => void
  env?: NodeJS.ProcessEnv
}): Promise<number | null> {
  options.signal.throwIfAborted()
  const windows = process.platform === "win32"
  const child = spawn(options.file, options.args, {
    cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true,
    env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0", ...options.env },
  })
  const killTree = () => {
    if (!child.pid) return
    if (windows) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {})
    } else {
      try { process.kill(-child.pid, "SIGKILL") } catch { /* group already exited */ }
    }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree() }, options.timeoutMs)
  const abort = () => killTree()
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) killTree()
  const stdout = new StringDecoder("utf8")
  const stderr = new StringDecoder("utf8")
  child.stdout.on("data", (chunk: Buffer) => options.output(stdout.write(chunk)))
  child.stderr.on("data", (chunk: Buffer) => options.output(stderr.write(chunk)))
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    options.output(stdout.end() + stderr.end())
    options.signal.throwIfAborted()
    if (timedOut) throw new Error("Command timed out")
    return code
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener("abort", abort)
    // Completing the command also ends any background descendants.
    killTree()
  }
}
