import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/contexts/SessionInventoryContext", () => ({ useSessionInventory: () => ({ removeSession: vi.fn() }) }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, jsonFetch: vi.fn() }))

import { useAppHandlers } from "@/hooks/useAppHandlers"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionSettingField } from "../../../shared/contracts/sessionSettings"
import type { ParsedSession } from "../../../shared/session/types"

const PICKED: PermissionsConfig = { mode: "plan", allowedTools: ["Read"], disallowedTools: [] }

interface Picks {
  permissionsConfig?: PermissionsConfig
  settingsChange?: readonly SessionSettingField[]
  onSettingsChangeSent?: () => void
}

function renderHandlers({ permissionsConfig, settingsChange = [], onSettingsChangeSent = vi.fn() }: Picks) {
  return renderHook(() => useAppHandlers({
    state: {
      session: { sessionId: "s1", turns: [] } as unknown as ParsedSession,
      sessionSource: { dirName: "-work-app", fileName: "s1.jsonl", rawText: "" },
    },
    dispatch: vi.fn(),
    isMobile: false,
    handleJumpToTurn: vi.fn(),
    markPermissionsApplied: vi.fn(),
    hasPermsPendingChanges: false,
    permissionsConfig,
    settingsChange,
    onSettingsChangeSent,
    selectedModel: "opus",
    selectedEffort: "high",
    fastMode: false,
    ultracode: false,
    mcpConfig: null,
    scrollRequestScrollToTop: vi.fn(),
    handleDashboardSelect: vi.fn(),
    workerParse: vi.fn(),
    canInteract: true,
  }))
}

async function appliedBody(picks: Picks): Promise<Record<string, unknown>> {
  const { result } = renderHandlers(picks)
  await act(() => result.current.handleApplySettings())
  const [url, init] = mocks.authFetch.mock.calls.at(-1) as [string, RequestInit]
  expect(url).toBe("/api/claude/settings/s1")
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe("useAppHandlers applying settings to a live session", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
    mocks.authFetch.mockResolvedValue(new Response("{}"))
  })

  it("leaves the session's own permission mode alone when the user picked none", async () => {
    const body = await appliedBody({})

    expect(body).toMatchObject({ model: "opus", effort: "high" })
    expect(body).not.toHaveProperty("permissionMode")
    expect(body).not.toHaveProperty("allowedTools")
  })

  it("sends the permissions the user picked", async () => {
    expect(await appliedBody({ permissionsConfig: PICKED })).toMatchObject({ permissionMode: "plan", allowedTools: ["Read"], disallowedTools: [] })
  })

  it("names the settings the user picked in settingsChange, and none when nothing was picked", async () => {
    expect(await appliedBody({})).not.toHaveProperty("settingsChange")
    expect(await appliedBody({ settingsChange: ["effort"] })).toMatchObject({ effort: "high", settingsChange: ["effort"] })
  })

  it("reports a settings change applied only once the session took it", async () => {
    const onSettingsChangeSent = vi.fn()
    mocks.authFetch.mockResolvedValueOnce(new Response("{}", { status: 400 }))
    const { result } = renderHandlers({ settingsChange: ["model"], onSettingsChangeSent })

    await act(() => result.current.handleApplySettings())
    expect(onSettingsChangeSent).not.toHaveBeenCalled()

    await act(() => result.current.handleApplySettings())
    expect(onSettingsChangeSent).toHaveBeenCalledOnce()
  })
})
