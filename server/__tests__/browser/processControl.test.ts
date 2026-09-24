// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { elapsedMs, listDaemonProcesses, processCommandLine, terminateProcess } from "../../browser/processControl"

describe("elapsedMs", () => {
  it.each([
    ["00:05", 5_000],
    ["12:34", 754_000],
    ["01:00:00", 3_600_000],
    ["11-02:03:04", ((11 * 24 + 2) * 3600 + 3 * 60 + 4) * 1_000],
  ])("reads %s", (etime, ms) => {
    expect(elapsedMs(etime)).toBe(ms)
  })

  it("reads nothing it does not recognize", () => {
    expect(elapsedMs("soon")).toBeNull()
  })
})

describe("listDaemonProcesses", () => {
  const DAEMON = "node /u/.bun/install/global/node_modules/agent-browser/bin/../dist/daemon.js"
  const TABLE = [
    `  101 11-02:03:04 ${DAEMON}`,
    `  102       00:10 ${DAEMON}`,
    "  103       05:00 /bin/zsh -c agent-browser open x",
    "  104       05:00 node /elsewhere/daemon.js",
  ].join("\n")

  function runner(environments: Record<string, string>) {
    return vi.fn((_file: string, args: string[]) => {
      if (args[0] === "-A") return TABLE
      return environments[args.at(-1) ?? ""] ?? ""
    })
  }

  it("names each daemon's browser and socket dir from the environment ps prints after its command", () => {
    const run = runner({
      101: `${DAEMON} HOME=/Users/me AGENT_BROWSER_SESSION=work AGENT_BROWSER_SOCKET_DIR=/Users/me/My Files/.cogpit/browser/run/shared PATH=/usr/bin\n`,
      102: `${DAEMON} AGENT_BROWSER_SOCKET_DIR=/t/run/s1 AGENT_BROWSER_SESSION=tmp-a\n`,
    })
    expect(listDaemonProcesses("darwin", run)).toEqual([
      { pid: 101, name: "work", socketDir: "/Users/me/My Files/.cogpit/browser/run/shared", ageMs: ((11 * 24 + 2) * 3600 + 3 * 60 + 4) * 1_000 },
      { pid: 102, name: "tmp-a", socketDir: "/t/run/s1", ageMs: 10_000 },
    ])
    expect(run).toHaveBeenCalledWith("ps", ["eww", "-o", "command=", "-p", "101"])
  })

  it("skips a daemon whose environment names no browser", () => {
    expect(listDaemonProcesses("darwin", runner({ 101: `${DAEMON} HOME=/Users/me\n` }))).toEqual([])
  })

  it("lists nothing on Windows, or when ps fails", () => {
    expect(listDaemonProcesses("win32", runner({}))).toEqual([])
    expect(listDaemonProcesses("darwin", vi.fn(() => { throw new Error("no ps") }))).toEqual([])
  })
})

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
