import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { useSlashSuggestions } from "../useSlashSuggestions"

describe("useSlashSuggestions capability gate", () => {
  beforeEach(() => mocks.authFetch.mockReset())

  it("does not inspect command files while config access is disabled", () => {
    const { result } = renderHook(() => useSlashSuggestions("/srv/project", false))

    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(result.current).toEqual({ suggestions: [], loading: false })
  })
})
