import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { activeSessionsUrl, listUrl, useSessionListFilter, type ListFilter } from "@/lib/sessionListFilter"
import { activeSessionsCacheKey } from "@/lib/sessionListCache"
import { installStubListFilter } from "@/__tests__/listFilter"

const UNFILTERED: ListFilter = { key: null, query: {} }

afterEach(() => {
  cleanup()
  __resetEditionUiForTest()
})

describe("activeSessionsUrl", () => {
  it("leaves unfiltered requests exactly as they were", () => {
    expect(activeSessionsUrl({}, UNFILTERED)).toBe("/api/active-sessions")
    expect(activeSessionsUrl({ archived: "include" }, UNFILTERED)).toBe("/api/active-sessions?archived=include")
  })

  it("adds the filter's query after the request's own", () => {
    const filter: ListFilter = { key: "narrow", query: { view: "narrow" } }
    expect(activeSessionsUrl({}, filter)).toBe("/api/active-sessions?view=narrow")
    expect(activeSessionsUrl(new URLSearchParams({ limit: "12", perProject: "3" }), filter))
      .toBe("/api/active-sessions?limit=12&perProject=3&view=narrow")
    expect(listUrl("/api/mission-control", filter)).toBe("/api/mission-control?view=narrow")
  })
})

describe("activeSessionsCacheKey", () => {
  it("keeps the unfiltered key and gives every filter its own", () => {
    expect(activeSessionsCacheKey(null)).toBe("active-sessions")
    expect(activeSessionsCacheKey("narrow")).not.toBe(activeSessionsCacheKey(null))
    expect(activeSessionsCacheKey("narrow")).not.toBe(activeSessionsCacheKey("other"))
  })
})

describe("useSessionListFilter", () => {
  it("is unfiltered without an edition", () => {
    const { result } = renderHook(() => useSessionListFilter())

    expect(result.current).toEqual(UNFILTERED)
  })

  it("is unfiltered while the edition's filter is off, and the same object when an edition installs", () => {
    const { result } = renderHook(() => useSessionListFilter())
    const before = result.current

    act(() => { installStubListFilter() })

    expect(result.current).toBe(before)
  })

  it("follows the edition's filter, one object per key", () => {
    const filter = installStubListFilter()
    const { result } = renderHook(() => useSessionListFilter())

    act(() => filter.setKey("narrow"))
    const narrow = result.current
    expect(narrow).toEqual({ key: "narrow", query: { filter: "narrow" } })

    act(() => filter.setKey("narrow"))
    expect(result.current).toBe(narrow)

    act(() => filter.setKey(null))
    expect(result.current).toEqual(UNFILTERED)
  })

  it("follows an edition installed while mounted", () => {
    const { result } = renderHook(() => useSessionListFilter())

    act(() => { installStubListFilter("narrow") })

    expect(result.current.key).toBe("narrow")
  })

  it("stays unfiltered under an edition without a filter", () => {
    __installEditionUiForTest({})
    const { result } = renderHook(() => useSessionListFilter())

    expect(result.current).toEqual(UNFILTERED)
  })
})
