import { runManagedCommand } from "../lib/managedCommand"

export function runSetupCommand(options: {
  cwd: string
  command: string
  timeoutMs: number
  signal: AbortSignal
  output: (text: string) => void
}): Promise<number | null> {
  const windows = process.platform === "win32"
  return runManagedCommand({
    ...options,
    file: windows ? process.env.COMSPEC || "cmd.exe" : "/bin/sh",
    args: windows ? ["/d", "/s", "/c", options.command] : ["-c", options.command],
    env: { COGPIT_WORKTREE_SETUP: "1" },
  })
}
