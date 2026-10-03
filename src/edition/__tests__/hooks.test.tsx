import { act, renderHook } from "@testing-library/react"
import { Users } from "lucide-react"
import { afterEach, describe, expect, it } from "vitest"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { type MeResponse, NO_CAPABILITIES } from "../../../shared/contracts/identity"
import type { EditionMainView, EditionUi } from "../contract"
import { useEditionIdentity, useEditionUi, useMainView, useMainViews } from "../hooks"
import { PERSONAL_UI } from "../personal"
import { __installEditionUiForTest, __resetEditionUiForTest } from "../registry"

const MEMBER: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_bob", username: "bob", displayName: "Bob" },
  capabilities: { ...NO_CAPABILITIES, manageWidgets: true },
}

function mainView(id: string, isAvailable: EditionMainView["isAvailable"]): EditionMainView {
  return { id, label: id, icon: Users, keywords: id, isAvailable, Component: () => null }
}

afterEach(() => {
  __resetEditionUiForTest()
  __resetCapabilitiesForTest()
})

describe("useEditionUi", () => {
  it("renders personal slots, then an edition's once it installs under the mounted component", () => {
    const { result } = renderHook(() => useEditionUi())
    expect(result.current).toBe(PERSONAL_UI)

    const ui: EditionUi = { mainViews: [] }
    act(() => __installEditionUiForTest(ui))

    expect(result.current).toBe(ui)
  })
})

describe("useEditionIdentity", () => {
  it("reads the active device's edition, user and capabilities", () => {
    const { result } = renderHook(() => useEditionIdentity())
    expect(result.current.edition).toBe("personal")
    expect(result.current.can("terminal")).toBe(true)

    act(() => setMe(MEMBER))

    expect(result.current).toMatchObject({ edition: "team", user: MEMBER.user, hubUser: MEMBER.user })
    expect(result.current.can("terminal")).toBe(false)
    expect(result.current.can("manageWidgets")).toBe(true)
  })

  it("holds no capability the server does not report", () => {
    const { result } = renderHook(() => useEditionIdentity())

    expect(result.current.can("launchRockets")).toBe(false)
  })

  it("keeps one snapshot until the identity changes", () => {
    const { result, rerender } = renderHook(() => useEditionIdentity())
    const first = result.current

    rerender()
    expect(result.current).toBe(first)

    act(() => setMe(MEMBER))
    expect(result.current).not.toBe(first)
  })
})

describe("useMainViews", () => {
  it("offers none without an edition UI", () => {
    const { result } = renderHook(() => useMainViews())

    expect(result.current).toEqual([])
  })

  it("offers the installed views the active identity may open, again as it changes", () => {
    const always = mainView("always", () => true)
    const managers = mainView("managers", (identity) => identity.can("configWrite"))
    __installEditionUiForTest({ mainViews: [always, managers] })
    const { result } = renderHook(() => useMainViews())
    expect(result.current).toEqual([always, managers])

    act(() => setMe(MEMBER))

    expect(result.current).toEqual([always])
  })
})

describe("useMainView", () => {
  it("names the view by id while the active identity may open it", () => {
    const managers = mainView("managers", (identity) => identity.can("configWrite"))
    __installEditionUiForTest({ mainViews: [managers] })
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useMainView(id), {
      initialProps: { id: "managers" as string | null },
    })
    expect(result.current).toBe(managers)

    rerender({ id: null })
    expect(result.current).toBeNull()

    rerender({ id: "managers" })
    act(() => setMe(MEMBER))
    expect(result.current).toBeNull()
  })

  it("names nothing for an id no edition registered", () => {
    const { result } = renderHook(() => useMainView("reports"))

    expect(result.current).toBeNull()
  })
})
