// @vitest-environment node

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  activeProcesses as helperActiveProcesses,
  cleanupProcesses as helperCleanupProcesses,
  persistentSessions as helperPersistentSessions,
} from "../helpers"
import {
  activeProcesses,
  cleanupProcesses,
  persistentSessions,
} from "../processRegistry"

describe("processRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    activeProcesses.clear()
    persistentSessions.clear()
  })

  afterEach(() => {
    activeProcesses.clear()
    persistentSessions.clear()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("keeps the helpers compatibility facade on the same singleton registry", () => {
    expect(helperActiveProcesses).toBe(activeProcesses)
    expect(helperPersistentSessions).toBe(persistentSessions)
    expect(helperCleanupProcesses).toBe(cleanupProcesses)

    const proc = { pid: 101, kill: vi.fn() }
    helperActiveProcesses.set("shared", proc as never)
    expect(activeProcesses.get("shared")).toBe(proc)
  })

  it("preserves watcher, signal, deletion, and force-kill ordering", () => {
    const events: string[] = []
    const activeProc = {
      pid: 201,
      kill: vi.fn((signal: string) => events.push(`active:${signal}`)),
    }
    const persistentProc = {
      pid: 202,
      kill: vi.fn((signal: string) => events.push(`persistent:${signal}`)),
    }

    activeProcesses.set("active", activeProc as never)
    persistentSessions.set("persistent", {
      proc: persistentProc,
      subagentWatcher: { close: () => events.push("watcher:close") },
    } as never)

    cleanupProcesses()

    expect(events).toEqual([
      "active:SIGTERM",
      "watcher:close",
      "persistent:SIGTERM",
    ])
    expect(activeProcesses.size).toBe(0)
    expect(persistentSessions.size).toBe(0)

    vi.advanceTimersByTime(3_000)

    expect(events).toEqual([
      "active:SIGTERM",
      "watcher:close",
      "persistent:SIGTERM",
      "active:SIGKILL",
      "persistent:SIGKILL",
    ])
  })

  it("signals a process only once when both registries reference it", () => {
    const proc = { pid: 303, kill: vi.fn() }
    activeProcesses.set("shared", proc as never)
    persistentSessions.set("shared", {
      proc,
      subagentWatcher: { close: vi.fn() },
    } as never)

    cleanupProcesses()
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenLastCalledWith("SIGTERM")

    vi.advanceTimersByTime(3_000)
    expect(proc.kill).toHaveBeenCalledTimes(2)
    expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL")
  })

  it("resolves after an observed graceful exit without force-killing", async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 404,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(function (this: EventEmitter, signal: NodeJS.Signals) {
        if (signal === "SIGTERM") this.emit("close", null, signal)
        return true
      }),
    })
    activeProcesses.set("graceful", proc as never)

    await cleanupProcesses()

    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("awaits the grace period and observes a stubborn child close after SIGKILL", async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 405,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(function (this: EventEmitter, signal: NodeJS.Signals) {
        if (signal === "SIGKILL") this.emit("close", null, signal)
        return true
      }),
    })
    activeProcesses.set("stubborn", proc as never)
    let settled = false

    const cleanup = cleanupProcesses().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    expect(proc.kill).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await cleanup

    expect(proc.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(settled).toBe(true)
  })
})
