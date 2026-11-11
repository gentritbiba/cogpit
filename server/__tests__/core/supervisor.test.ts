// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { tmpdir } from "node:os"

import { CoreBinaryMissingError } from "../../core/binary"
import { CORE_SECRET_HEADER } from "../../core/protocol"
import { coreEndpoint, startCore, whenCoreReady, type CoreEndpoint, type CoreLease } from "../../core/supervisor"

const leases: CoreLease[] = []

async function lease(): Promise<CoreLease> {
  const taken = await startCore({ dataDir: tmpdir() })
  leases.push(taken)
  return taken
}

afterEach(async () => {
  await Promise.all(leases.splice(0).map((taken) => taken.release()))
  vi.unstubAllEnvs()
})

function health(endpoint: CoreEndpoint, secret = endpoint.secret): Promise<number> {
  return fetch(`${endpoint.origin}/v1/health`, { headers: { [CORE_SECRET_HEADER]: secret } })
    .then((response) => response.status)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("core supervisor", () => {
  it("starts the real binary and answers only with the boot secret", async () => {
    await lease()
    const endpoint = coreEndpoint()!
    expect(endpoint.port).toBeGreaterThan(0)
    expect(await health(endpoint)).toBe(200)
    expect(await health(endpoint, "not-the-secret")).toBe(401)
  })

  it("shares one process between leases and stops it with the last release", async () => {
    const first = await lease()
    const second = await lease()
    const { pid } = coreEndpoint()!
    await first.release()
    expect(coreEndpoint()?.pid).toBe(pid)
    await second.release()
    expect(coreEndpoint()).toBeNull()
    await waitUntil(() => !isAlive(pid))
    await expect(whenCoreReady()).rejects.toThrow(/not running/)
  })

  it("restarts the core after it crashes", async () => {
    await lease()
    const before = coreEndpoint()!
    process.kill(before.pid, "SIGKILL")
    await waitUntil(() => coreEndpoint() === null || coreEndpoint()!.pid !== before.pid)
    const after = await whenCoreReady()
    expect(after.pid).not.toBe(before.pid)
    expect(await health(after)).toBe(200)
  })

  it("refuses to start without a binary", async () => {
    vi.stubEnv("COGPIT_CORE_BIN", "")
    await expect(startCore({ coreBin: `${tmpdir()}/missing-cogpit-core`, dataDir: tmpdir() }))
      .rejects.toBeInstanceOf(CoreBinaryMissingError)
    expect(coreEndpoint()).toBeNull()
  })
})
