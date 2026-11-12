// @vitest-environment node
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startupFailureMessage, waitForServerReady } from "../serverStartup"

function fakeWorker() {
  return new EventEmitter() as EventEmitter & Parameters<typeof waitForServerReady>[0]
}

describe("waitForServerReady", () => {
  afterEach(() => vi.useRealTimers())

  it("resolves with the port the worker reports", async () => {
    const worker = fakeWorker()
    const ready = waitForServerReady(worker)
    worker.emit("message", { type: "notify", title: "unrelated" })
    worker.emit("message", { type: "ready", port: 51234 })
    await expect(ready).resolves.toBe(51234)
  })

  it("rejects when the worker exits before it is ready", async () => {
    const worker = fakeWorker()
    const ready = waitForServerReady(worker)
    worker.emit("exit", 1)
    await expect(ready).rejects.toThrow("The server stopped before it was ready (exit code 1).")
  })

  it("rejects with the worker's own reason when it reports an error", async () => {
    const worker = fakeWorker()
    const ready = waitForServerReady(worker)
    worker.emit("message", { type: "error", error: "Error: listen EADDRINUSE: address already in use 0.0.0.0:19384" })
    await expect(ready).rejects.toThrow("listen EADDRINUSE")
  })

  it("rejects when the worker never answers", async () => {
    vi.useFakeTimers()
    const worker = fakeWorker()
    const ready = waitForServerReady(worker, 15_000)
    const settled = expect(ready).rejects.toThrow("The server did not start within 15 seconds.")
    await vi.advanceTimersByTimeAsync(15_000)
    await settled
  })

  it("ignores an exit once the server is ready", async () => {
    vi.useFakeTimers()
    const worker = fakeWorker()
    const ready = waitForServerReady(worker, 1_000)
    worker.emit("message", { type: "ready", port: 4000 })
    worker.emit("exit", 0)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(ready).resolves.toBe(4000)
  })
})

describe("startupFailureMessage", () => {
  it("gives the reason and where the startup log is", () => {
    expect(startupFailureMessage(new Error("The server stopped before it was ready (exit code 1)."), "/Users/me/Library/Logs/Cogpit/startup.log"))
      .toBe("The server stopped before it was ready (exit code 1).\n\nThe startup log has the details:\n/Users/me/Library/Logs/Cogpit/startup.log")
  })

  it("gives just the reason when no log could be written", () => {
    expect(startupFailureMessage("boom", null)).toBe("boom")
  })
})
