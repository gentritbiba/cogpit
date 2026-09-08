// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { processCommandLine, terminateProcess } from "../../browser/processControl"

describe("processCommandLine", () => {
  it("asks ps for the command on POSIX", () => {
    const run = vi.fn(() => "node /x/agent-browser/dist/daemon.js\n")
    expect(processCommandLine(100, "darwin", run)).toBe("node /x/agent-browser/dist/daemon.js\n")
    expect(run).toHaveBeenCalledWith("ps", ["-o", "command=", "-p", "100"])
  })

  it("asks PowerShell for the command line on Windows", () => {
    const run = vi.fn(() => "node.exe C:\\x\\agent-browser\\dist\\daemon.js\r\n")
    expect(processCommandLine(100, "win32", run)).toContain("agent-browser")
    expect(run).toHaveBeenCalledWith("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter 'ProcessId = 100').CommandLine",
    ])
  })

  it("reports an empty command when the lookup fails", () => {
    const run = vi.fn(() => { throw new Error("no such process") })
    expect(processCommandLine(100, "darwin", run)).toBe("")
    expect(processCommandLine(100, "win32", run)).toBe("")
  })
})

describe("terminateProcess", () => {
  it("signals the process on POSIX", () => {
    const kill = vi.fn()
    const run = vi.fn()
    terminateProcess(100, "SIGTERM", "linux", run, kill)
    expect(kill).toHaveBeenCalledWith(100, "SIGTERM")
    expect(run).not.toHaveBeenCalled()
  })

  it("kills the whole tree on Windows, where a terminated daemon would orphan its Chromium", () => {
    const kill = vi.fn()
    const run = vi.fn(() => "")
    terminateProcess(100, "SIGTERM", "win32", run, kill)
    expect(run).toHaveBeenCalledWith("taskkill", ["/pid", "100", "/t", "/f"])
    expect(kill).not.toHaveBeenCalled()
  })
})
