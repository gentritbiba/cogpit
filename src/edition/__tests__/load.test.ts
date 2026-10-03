import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/** What the build's `@cogpit/edition-ui` turns out to be in each test. */
const build = {
  outcome: "team" as "team" | "none" | "other" | "fail",
  imports: 0,
  ui: { mainViews: [] },
}

/** The build's `@cogpit/edition-ui`, read each time a fresh loader imports it. */
function editionUiModule() {
  build.imports += 1
  if (build.outcome === "fail") throw new Error("Failed to fetch dynamically imported module")
  if (build.outcome === "none") return { default: null }
  return { default: { edition: build.outcome === "team" ? "team" : "enterprise", ui: build.ui } }
}

const RELOAD_FLAG = "cogpit:edition-ui-reloaded"

type Load = typeof import("../load")
type Registry = typeof import("../registry")
let load: Load
let registry: Registry

beforeEach(async () => {
  vi.resetModules()
  vi.doMock("@cogpit/edition-ui", editionUiModule)
  build.outcome = "team"
  build.imports = 0
  sessionStorage.clear()
  load = await import("../load")
  registry = await import("../registry")
})

describe("loadEditionUi", () => {
  it("never imports the edition UI for personal edition", async () => {
    await load.loadEditionUi("personal")

    expect(build.imports).toBe(0)
    expect(registry.editionUiState()).toBe("idle")
  })

  it("installs the UI of the edition a server reports", async () => {
    await load.loadEditionUi("team")

    expect(registry.editionUiState()).toBe("installed")
    expect(registry.editionUi()).toBe(build.ui)
  })

  it("imports once however many ask at the same time", async () => {
    await Promise.all([load.loadEditionUi("team"), load.loadEditionUi("team"), load.importEditionUi()])

    expect(build.imports).toBe(1)
    expect(registry.editionUiState()).toBe("installed")
  })

  it.each([
    ["has none", "none"],
    ["has another edition's", "other"],
  ] as const)("keeps personal slots when the build %s", async (_what, outcome) => {
    build.outcome = outcome

    await load.loadEditionUi("team")

    expect(registry.editionUiState()).toBe("unavailable")
    expect(registry.editionUi()).not.toBe(build.ui)
  })

  it("reloads the page once for a chunk it cannot fetch, then gives up and retries the import later", async () => {
    build.outcome = "fail"

    // The page is reloading: the app keeps waiting rather than render without the UI.
    await load.loadEditionUi("team")
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBe("1")
    expect(registry.editionUiState()).toBe("loading")

    registry.__resetEditionUiForTest()
    await load.loadEditionUi("team")
    expect(registry.editionUiState()).toBe("unavailable")

    build.outcome = "team"
    await load.loadEditionUi("team")
    expect(registry.editionUiState()).toBe("installed")
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()
  })

  it("stops at an error for the server's own edition, clearing the reload flag, and retries without reloading", async () => {
    build.outcome = "fail"

    await load.loadEditionUi("team", { required: true })
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBe("1")
    expect(registry.editionUiState()).toBe("loading")

    // After the reload the chunk still fails: the app shows an error, not personal slots.
    registry.__resetEditionUiForTest()
    await load.loadEditionUi("team", { required: true })
    expect(registry.editionUiState()).toBe("failed")
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()

    // Only a retry asks again, and it never reloads the page.
    await load.loadEditionUi("team", { required: true })
    expect(build.imports).toBe(2)
    await load.retryEditionUi("team")
    expect(build.imports).toBe(3)
    expect(registry.editionUiState()).toBe("failed")
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()

    build.outcome = "team"
    await load.retryEditionUi("team")
    expect(registry.editionUiState()).toBe("installed")
    expect(registry.editionUi()).toBe(build.ui)
  })

  it.each([
    ["has none", "none"],
    ["has another edition's", "other"],
  ] as const)("keeps personal slots for the server's own edition when the build %s", async (_what, outcome) => {
    build.outcome = outcome

    await load.loadEditionUi("team", { required: true })

    expect(registry.editionUiState()).toBe("unavailable")
  })
})

describe("useEditionUiReadiness", () => {
  it("is ready at once, loading nothing, while every reported edition is personal or unknown", () => {
    const { result } = renderHook(() => load.useEditionUiReadiness(null, "personal"))

    expect(result.current).toMatchObject({ serverReady: true, ready: true, failed: false })
    expect(build.imports).toBe(0)
  })

  it("holds the server's screens until the UI of its own edition is installed", async () => {
    const { result } = renderHook(() => load.useEditionUiReadiness("team", null))
    expect(result.current).toMatchObject({ serverReady: false, ready: false })

    await waitFor(() => expect(result.current).toMatchObject({ serverReady: true, ready: true }))
    expect(registry.editionUiState()).toBe("installed")
  })

  it("lets the server's screens render while a device of another edition loads its UI", async () => {
    const { result, rerender } = renderHook(({ device }) => load.useEditionUiReadiness("personal", device), {
      initialProps: { device: null as "team" | null },
    })
    expect(result.current).toMatchObject({ serverReady: true, ready: true })

    rerender({ device: "team" })
    expect(result.current).toMatchObject({ serverReady: true, ready: false })

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(registry.editionUiState()).toBe("installed")
  })

  it("stops waiting once the build turns out to have no UI for it", async () => {
    build.outcome = "none"
    const { result } = renderHook(() => load.useEditionUiReadiness("team", null))

    await waitFor(() => expect(result.current).toMatchObject({ serverReady: true, ready: true, failed: false }))
    expect(registry.editionUiState()).toBe("unavailable")
  })

  it("falls back to personal slots when a device's edition UI cannot be fetched", async () => {
    build.outcome = "fail"
    sessionStorage.setItem(RELOAD_FLAG, "1")
    const { result } = renderHook(() => load.useEditionUiReadiness("personal", "team"))

    await waitFor(() => expect(result.current).toMatchObject({ ready: true, failed: false }))
    expect(registry.editionUiState()).toBe("unavailable")
  })

  it("reports the server's own edition UI failing to fetch, and retries it on demand", async () => {
    build.outcome = "fail"
    sessionStorage.setItem(RELOAD_FLAG, "1")
    const { result } = renderHook(() => load.useEditionUiReadiness("team", "team"))

    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current).toMatchObject({ serverReady: false, ready: false })
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()

    build.outcome = "team"
    act(() => result.current.retry())

    await waitFor(() => expect(result.current).toMatchObject({ serverReady: true, ready: true, failed: false }))
    expect(registry.editionUi()).toBe(build.ui)
    expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull()
  })
})

