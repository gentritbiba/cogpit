import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditionUi } from "../contract"
import { PERSONAL_UI } from "../personal"
import {
  __installEditionUiForTest,
  __resetEditionUiForTest,
  editionUi,
  editionUiState,
  installEditionUi,
  markEditionUiFailed,
  markEditionUiLoading,
  markEditionUiUnavailable,
  subscribeEditionUi,
} from "../registry"

const TEAM_UI: EditionUi = { mainViews: [] }

afterEach(() => {
  __resetEditionUiForTest()
})

describe("the edition UI registry", () => {
  it("starts on personal edition's empty slots", () => {
    expect(editionUi()).toBe(PERSONAL_UI)
    expect(editionUiState()).toBe("idle")
    expect(Object.isFrozen(PERSONAL_UI)).toBe(true)
  })

  it("installs an edition's UI and tells its subscribers", () => {
    const listener = vi.fn()
    subscribeEditionUi(listener)

    installEditionUi({ edition: "team", ui: TEAM_UI })

    expect(editionUi()).toBe(TEAM_UI)
    expect(editionUiState()).toBe("installed")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("installs once per page", () => {
    installEditionUi({ edition: "team", ui: TEAM_UI })

    expect(() => installEditionUi({ edition: "team", ui: {} })).toThrow("already installed")
    expect(editionUi()).toBe(TEAM_UI)
  })

  it("keeps an installed UI through later loads and failures", () => {
    installEditionUi({ edition: "team", ui: TEAM_UI })

    markEditionUiLoading()
    markEditionUiUnavailable()
    markEditionUiFailed()

    expect(editionUiState()).toBe("installed")
    expect(editionUi()).toBe(TEAM_UI)
  })

  it("stays on personal slots while loading and once the UI is unavailable or failed", () => {
    markEditionUiLoading()
    expect(editionUiState()).toBe("loading")

    markEditionUiUnavailable()
    expect(editionUiState()).toBe("unavailable")
    expect(editionUi()).toBe(PERSONAL_UI)

    markEditionUiFailed()
    expect(editionUiState()).toBe("failed")
    expect(editionUi()).toBe(PERSONAL_UI)
  })

  it("stops telling a subscriber that unsubscribed", () => {
    const listener = vi.fn()
    subscribeEditionUi(listener)()

    __installEditionUiForTest(TEAM_UI)

    expect(listener).not.toHaveBeenCalled()
    expect(editionUi()).toBe(TEAM_UI)
  })
})
