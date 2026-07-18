import { describe, expect, it } from "vitest"

import {
  classifyProcesses,
  parseEtimeSeconds,
  parsePsOutput,
} from "../../lib/systemProcesses"

// Modeled on a real leak incident: an orphaned claude session (ppid 1) kept a
// runaway bun test script alive for 64 days, and a leaked agent-browser
// headless Chrome burned ~55% CPU for 2 days — none of it visible in Cogpit.
const PS_FIXTURE = [
  "  100     1  0.0  20000 64-02:09:34 claude",
  "  101   100  0.0   1000 64-00:23:44 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snap.sh",
  "  102   101 19.0  90000 63-23:58:56 bun -e process.stdout.write('hi')",
  "  200     1  0.0  40000 01-22:55:47 node /Users/me/.bun/install/global/node_modules/agent-browser/bin/../dist/daemon.js",
  "  201   200  0.0  50000 01-22:55:46 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell --type=browser",
  "  202   201 54.6 150000 01-22:55:46 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell --type=renderer",
  "  300   299  8.1 120000       02:45 claude --dangerously-skip-permissions",
  "  301     1  0.0  30000 09-17:04:03 bun /private/tmp/claude-501/project/scratchpad/ua-echo.ts",
  "  400     1  3.4 400000    14:29:11 /Applications/Cogpit.app/Contents/Frameworks/Cogpit Helper (Renderer).app/Contents/MacOS/Cogpit Helper (Renderer) --type=renderer",
  "  500   499  0.0   5000       01:02 ps -axo pid=,ppid=,pcpu=,rss=,etime=,args=",
  "  600     1  2.0  80000 10-00:00:00 /Applications/Spotify.app/Contents/MacOS/Spotify",
].join("\n")

describe("parseEtimeSeconds", () => {
  it("parses MM:SS, HH:MM:SS, and DD-HH:MM:SS forms", () => {
    expect(parseEtimeSeconds("02:45")).toBe(165)
    expect(parseEtimeSeconds("14:29:11")).toBe(14 * 3600 + 29 * 60 + 11)
    expect(parseEtimeSeconds("64-02:09:34")).toBe(64 * 86400 + 2 * 3600 + 9 * 60 + 34)
  })

  it("returns 0 for malformed input", () => {
    expect(parseEtimeSeconds("")).toBe(0)
    expect(parseEtimeSeconds("garbage")).toBe(0)
  })
})

describe("parsePsOutput", () => {
  it("parses pid, ppid, cpu, rss, etime, and full command with spaces", () => {
    const rows = parsePsOutput(PS_FIXTURE)
    expect(rows).toHaveLength(11)
    const renderer = rows.find((row) => row.pid === 400)
    expect(renderer).toMatchObject({
      ppid: 1,
      cpuPercent: 3.4,
      rssKb: 400000,
      etime: "14:29:11",
    })
    expect(renderer?.command).toContain("Cogpit Helper (Renderer)")
  })

  it("skips malformed lines", () => {
    expect(parsePsOutput("not a process line\n\n")).toEqual([])
  })
})

describe("classifyProcesses", () => {
  const metrics = classifyProcesses(parsePsOutput(PS_FIXTURE), 9999)
  const byPid = new Map(metrics.map((metric) => [metric.pid, metric]))

  it("keeps agent tooling and Cogpit processes, drops unrelated ones", () => {
    expect(byPid.has(600)).toBe(false) // Spotify
    expect(byPid.has(500)).toBe(false) // the ps invocation itself
    expect(byPid.get(100)?.kind).toBe("claude")
    expect(byPid.get(200)?.kind).toBe("browser-daemon")
    expect(byPid.get(202)?.kind).toBe("headless-browser")
    expect(byPid.get(301)?.kind).toBe("script")
    expect(byPid.get(400)?.kind).toBe("cogpit")
  })

  it("flags orphaned claude sessions and their whole subtree as leaks", () => {
    expect(byPid.get(100)).toMatchObject({ orphaned: true, suspectedLeak: true })
    expect(byPid.get(101)?.suspectedLeak).toBe(true) // zsh under orphaned claude
    expect(byPid.get(102)?.suspectedLeak).toBe(true) // bun script under orphaned claude
  })

  it("flags high-CPU headless browsers but not idle daemons", () => {
    expect(byPid.get(202)?.suspectedLeak).toBe(true) // 54.6% CPU renderer, 2 days old
    expect(byPid.get(201)?.suspectedLeak).toBe(false) // idle headless main
    expect(byPid.get(200)?.suspectedLeak).toBe(false) // idle daemon
  })

  it("does not flag young busy browsers — they are likely mid-automation", () => {
    const young = classifyProcesses(parsePsOutput(
      "  700   699 80.0 100000       05:00 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell --type=renderer",
    ), 9999)
    expect(young[0]).toMatchObject({ kind: "headless-browser", suspectedLeak: false })
  })

  it("flags orphaned scripts but not attached claude sessions", () => {
    expect(byPid.get(301)?.suspectedLeak).toBe(true) // ppid 1 scratchpad script
    expect(byPid.get(300)).toMatchObject({ orphaned: false, suspectedLeak: false })
  })

  it("orders leaks first, then by CPU, and reports age and memory", () => {
    expect(metrics[0].suspectedLeak).toBe(true)
    expect(metrics[0].pid).toBe(202) // hottest leak first
    const orphan = byPid.get(100)
    expect(orphan?.ageSeconds).toBe(64 * 86400 + 2 * 3600 + 9 * 60 + 34)
    expect(byPid.get(202)?.memoryMb).toBeCloseTo(150000 / 1024, 0)
  })

  it("gives processes readable labels", () => {
    expect(byPid.get(100)?.label).toBe("Claude session")
    expect(byPid.get(202)?.label).toBe("Headless Chrome")
    expect(byPid.get(200)?.label).toBe("agent-browser daemon")
    expect(byPid.get(301)?.label).toBe("bun ua-echo.ts")
    expect(byPid.get(400)?.label).toBe("Cogpit Helper (Renderer)")
  })
})
