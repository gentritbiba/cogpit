// @vitest-environment node
import { describe, expect, it } from "vitest"

import { getConfig } from "../config"
import { startStandaloneServer } from "../standalone-runtime"
import { useAccountSignIn } from "./edition/fakeEdition"
import { fixture, runningServers, useStandaloneRuntimeFixture } from "./standaloneRuntimeFixture"

useStandaloneRuntimeFixture()

const WEAK_PASSWORD = { COGPIT_NETWORK_PASSWORD: "weak" }

describe("startStandaloneServer", () => {
  it("binds an available port and serves the app lifecycle", async () => {
    const { staticDir, dataDir } = await fixture()
    const runtime = await startStandaloneServer({
      staticDir,
      dataDir,
      host: "127.0.0.1",
      port: 0,
      env: {},
    })
    runningServers.push(runtime)

    expect(runtime.port).toBeGreaterThan(0)
    expect(runtime.url).toBe(`http://127.0.0.1:${runtime.port}`)

    const [hello, page] = await Promise.all([
      fetch(`${runtime.url}/api/hello`),
      fetch(`${runtime.url}/any/deep/link`),
    ])
    expect(hello.status).toBe(200)
    expect(await hello.json()).toMatchObject({ app: "cogpit", mode: "standalone" })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("portable cogpit")

    await runtime.dispose()
    runningServers.pop()
    await expect(fetch(`${runtime.url}/api/hello`)).rejects.toThrow()
  })

  it("refuses a passwordless non-loopback bind before listening", async () => {
    const { staticDir, dataDir } = await fixture()
    await expect(startStandaloneServer({
      staticDir,
      dataDir,
      host: "0.0.0.0",
      port: 0,
      env: {},
    })).rejects.toThrow("Refusing to bind")
  })

  it("refuses a weak shared network password in personal edition", async () => {
    const { staticDir, dataDir } = await fixture()
    await expect(startStandaloneServer({ staticDir, dataDir, host: "127.0.0.1", port: 0, env: WEAK_PASSWORD }))
      .rejects.toThrow("Network password is too weak")
  })

  it("ignores the shared network password when the edition signs accounts in", async () => {
    useAccountSignIn()
    const { staticDir, dataDir } = await fixture({ edition: "team" })
    // Accounts authenticate individually, so the shared password is
    // ignored rather than rejected for being weak or applied to the config.
    const runtime = await startStandaloneServer({ staticDir, dataDir, host: "127.0.0.1", port: 0, env: WEAK_PASSWORD })
    runningServers.push(runtime)

    expect(runtime.envPassword).toBe(true)
    expect(getConfig()?.networkPassword).toBeUndefined()
  })
})
