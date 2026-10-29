// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { runSetupCommand } from "../../worktreeSetup/command"

const unix = describe.skipIf(process.platform === "win32")
unix("setup process lifecycle", () => {
  it("kills child processes on cancellation and waits for command completion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setup-cancel-"))
    const controller = new AbortController()
    try {
      const running = runSetupCommand({ cwd, command: "sleep 30 & echo $! > child-pid; wait", timeoutMs: 10_000, signal: controller.signal, output: () => {} })
      const rejected = expect(running).rejects.toThrow()
      await vi.waitFor(() => access(join(cwd, "child-pid")))
      const pid = Number((await readFile(join(cwd, "child-pid"), "utf8")).trim())
      expect(pid).toBeGreaterThan(0)
      controller.abort(new Error("cancelled by user"))
      await rejected
      await vi.waitFor(() => {
        let status = ""
        try { status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim() } catch { /* exited */ }
        expect(status === "" || status.startsWith("Z")).toBe(true)
      })
    } finally { controller.abort(); await rm(cwd, { recursive: true, force: true }) }
  })
  it("enforces configured command timeout", async () => {
    await expect(runSetupCommand({ cwd: tmpdir(), command: "sleep 30", timeoutMs: 30, signal: new AbortController().signal, output: () => {} })).rejects.toThrow("timed out")
  })
})
