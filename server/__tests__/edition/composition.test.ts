// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerResponse } from "node:http"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { allRuntimes } from "../../agents/runtimes"
import { createServerComposition } from "../../app-server"
import { __resetEditionForTest } from "../../edition"
import { fixtureRoot, listen, staticDir, useAppServerFixture, userDataDir } from "../appServerFixture"
import { installFakeEdition } from "./fakeEdition"

/** What composition did, in order, as the edition and a wrapped plugin startup saw it. */
const steps = vi.hoisted(() => [] as string[])

vi.mock("../../plugins/startup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/startup")>()
  return {
    ...actual,
    initializeAppPlugins: (...args: Parameters<typeof actual.initializeAppPlugins>) => {
      steps.push("plugins")
      return actual.initializeAppPlugins(...args)
    },
  }
})

const compose = () => createServerComposition(staticDir, userDataDir, { mode: "standalone" })
const recordFlush = () => vi.fn(async () => { steps.push("flush") })

useAppServerFixture()

describe("composition with an installed edition", () => {
  const originalEdition = process.env.COGPIT_EDITION

  beforeEach(() => {
    steps.length = 0
    // Composition resolves the edition again; it must resolve to the one installed.
    process.env.COGPIT_EDITION = "team"
  })

  afterEach(() => {
    // A spy on a faked timer must come off before the real timers go back.
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (originalEdition === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEdition
    __resetEditionForTest()
  })

  it("boots the edition under Cogpit's data root before plugins and routes", async () => {
    const edition = installFakeEdition({
      boot: vi.fn(async () => { steps.push("boot") }),
      registerRoutes: vi.fn(() => { steps.push("routes") }),
    })

    const { dispose } = await compose()
    await dispose()

    expect(steps).toEqual(["boot", "plugins", "routes"])
    expect(edition.boot).toHaveBeenCalledWith({ dataRoot: userDataDir })
  })

  it("flushes the edition after the runtimes stop, and again once the server has closed", async () => {
    await writeFile(join(userDataDir, "config.local.json"), JSON.stringify({ claudeDir: fixtureRoot }))
    let held: ServerResponse | undefined
    const edition = installFakeEdition({
      flush: recordFlush(),
      registerRoutes: (use) => use("/api/team/hold", (_req, res) => { held = res }),
    })
    let stopRuntime = (): void => {}
    const shutdown = vi.spyOn(allRuntimes()[0], "shutdown").mockImplementationOnce(() => new Promise<void>((resolve) => {
      stopRuntime = () => {
        steps.push("runtime stopped")
        resolve()
      }
    }))
    const { httpServer, dispose } = await compose()
    const baseUrl = await listen(httpServer)
    httpServer.once("close", () => steps.push("server closed"))
    steps.length = 0

    const request = fetch(`${baseUrl}/api/team/hold`)
    await vi.waitFor(() => expect(held).toBeDefined())
    const disposed = dispose()
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalled())
    expect(edition.flush).not.toHaveBeenCalled()

    stopRuntime()
    await vi.waitFor(() => expect(steps).toEqual(["runtime stopped", "flush"]))
    held?.setHeader("Connection", "close")
    held?.end()
    await Promise.all([disposed, request])

    expect(steps).toEqual(["runtime stopped", "flush", "server closed", "flush"])
  })

  it("still flushes twice when a shutdown step fails, then reports the failure", async () => {
    const edition = installFakeEdition({ flush: recordFlush() })
    const failure = new Error("runtime would not stop")
    vi.spyOn(allRuntimes()[0], "shutdown").mockRejectedValueOnce(failure)

    const { dispose } = await compose()

    await expect(dispose()).rejects.toBe(failure)
    expect(edition.flush).toHaveBeenCalledTimes(2)
  })

  it("stops waiting on a hung step ten seconds after another has failed, holding the process open until then", async () => {
    const edition = installFakeEdition({ flush: recordFlush() })
    const failure = new Error("runtime would not stop")
    const [failing, hung] = allRuntimes()
    vi.spyOn(failing, "shutdown").mockRejectedValueOnce(failure)
    vi.spyOn(hung, "shutdown").mockReturnValueOnce(new Promise<void>(() => {}))
    const { dispose } = await compose()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const timers = vi.spyOn(globalThis, "setTimeout")

    let settled: unknown
    void dispose().catch((error: unknown) => { settled = error })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBeUndefined()
    expect(edition.flush).not.toHaveBeenCalled()
    const grace = timers.mock.results[timers.mock.calls.findIndex(([, delay]) => delay === 10_000)]
    expect(grace?.value.hasRef()).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(settled).toBe(failure))
    expect(edition.flush).toHaveBeenCalledTimes(2)
  })
})
