import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

// Mock authFetch before importing the hook
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useSkillMetadata } from "../useSkillMetadata"

const mockFetch = authFetch as unknown as ReturnType<typeof vi.fn>

function mockSuggestionsResponse(suggestions: Array<{
  name: string
  description?: string
  type: string
  source: string
  filePath?: string
}>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ suggestions }),
  })
}

describe("useSkillMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear the module-level cache between tests by resetting via a dummy unique cwd
  })

  it("returns an empty map when cwd is empty", () => {
    const { result } = renderHook(() => useSkillMetadata(""))
    expect(result.current.size).toBe(0)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("fetches and returns only skills from the response", async () => {
    const uniqueCwd = `/test/path-skills-only-${Date.now()}`
    mockSuggestionsResponse([
      { name: "commit", type: "skill", source: "user", description: "Create a commit", filePath: "/home/user/.claude/skills/commit/SKILL.md" },
      { name: "some-command", type: "command", source: "project", filePath: "/project/.claude/commands/some-command.md" },
      { name: "simplify", type: "skill", source: "built-in", description: "Review and simplify code", filePath: "" },
    ])

    const { result } = renderHook(() => useSkillMetadata(uniqueCwd))

    await waitFor(() => {
      expect(result.current.size).toBe(2)
    })

    // Only skills are included
    expect(result.current.has("commit")).toBe(true)
    expect(result.current.has("simplify")).toBe(true)
    expect(result.current.has("some-command")).toBe(false)
  })

  it("returns correct fields for each skill", async () => {
    const uniqueCwd = `/test/path-fields-${Date.now()}`
    mockSuggestionsResponse([
      {
        name: "commit",
        type: "skill",
        source: "user",
        description: "Create a commit",
        filePath: "/home/user/.claude/skills/commit/SKILL.md",
      },
    ])

    const { result } = renderHook(() => useSkillMetadata(uniqueCwd))

    await waitFor(() => {
      expect(result.current.has("commit")).toBe(true)
    })

    const meta = result.current.get("commit")
    expect(meta).toEqual({
      source: "user",
      description: "Create a commit",
      filePath: "/home/user/.claude/skills/commit/SKILL.md",
    })
  })

  it("does not fetch when cwd does not change (cache hit)", async () => {
    const uniqueCwd = `/test/path-cache-${Date.now()}`
    mockSuggestionsResponse([
      { name: "commit", type: "skill", source: "user", filePath: "/x/SKILL.md" },
    ])

    const { result, rerender } = renderHook(() => useSkillMetadata(uniqueCwd))

    await waitFor(() => {
      expect(result.current.size).toBe(1)
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Re-render with same cwd — should use cache, not fetch again
    rerender()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("handles non-ok response gracefully", async () => {
    const uniqueCwd = `/test/path-error-${Date.now()}`
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

    const { result } = renderHook(() => useSkillMetadata(uniqueCwd))

    // Should remain empty without throwing
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    expect(result.current.size).toBe(0)
  })

  it("handles fetch error gracefully", async () => {
    const uniqueCwd = `/test/path-fetch-error-${Date.now()}`
    mockFetch.mockRejectedValueOnce(new Error("Network error"))

    const { result } = renderHook(() => useSkillMetadata(uniqueCwd))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    expect(result.current.size).toBe(0)
  })
})
