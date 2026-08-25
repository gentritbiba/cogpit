import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { ConfigDialog } from "@/components/ConfigDialog"

const SAVED_CONFIG = {
  claudeDir: "/Users/me/.claude",
  networkAccess: false,
  networkPassword: null,
  terminalApp: "",
  editorApp: "cursor",
  useBuiltInEditor: false,
}

function mockConfig(overrides: Partial<typeof SAVED_CONFIG> = {}) {
  mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/config" && init?.method === "POST") {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, claudeDir: SAVED_CONFIG.claudeDir }) })
    }
    if (url === "/api/config") {
      return Promise.resolve({ ok: true, json: async () => ({ ...SAVED_CONFIG, ...overrides }) })
    }
    if (url === "/api/shares") return Promise.resolve({ ok: true, json: async () => [] })
    throw new Error(`Unexpected request: ${url}`)
  })
}

function renderDialog() {
  const onSaved = vi.fn()
  render(
    <ConfigDialog
      open
      currentPath={SAVED_CONFIG.claudeDir}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  )
  return { onSaved }
}

function editorInput() {
  return screen.getByLabelText("Editor application")
}

describe("ConfigDialog editor routing", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
  })

  it("leaves the editor field editable while files open externally", async () => {
    mockConfig()
    renderDialog()

    await waitFor(() => expect(editorInput()).toHaveValue("cursor"))
    expect(editorInput()).toBeEnabled()
    expect(screen.getByText(/Leave blank to use \$VISUAL/)).toBeInTheDocument()
  })

  it("disables the editor field as soon as files are routed into Cogpit", async () => {
    const user = userEvent.setup()
    mockConfig()
    const { onSaved } = renderDialog()

    await waitFor(() => expect(editorInput()).toHaveValue("cursor"))
    await user.click(screen.getByRole("checkbox", { name: /Open files in Cogpit/ }))

    expect(editorInput()).toBeDisabled()
    expect(screen.getByText("Not used while files open in Cogpit.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(SAVED_CONFIG.claudeDir))
    const save = mocks.authFetch.mock.calls.find((call) => call[1]?.method === "POST")
    expect(JSON.parse(save?.[1]?.body as string)).toMatchObject({
      editorApp: "cursor",
      useBuiltInEditor: true,
    })
  })

  it("restores the persisted preference when reopened", async () => {
    mockConfig({ useBuiltInEditor: true })
    renderDialog()

    await waitFor(() => expect(editorInput()).toBeDisabled())
    expect(screen.getByRole("checkbox", { name: /Open files in Cogpit/ })).toBeChecked()
    // Nothing changed yet, so there is nothing to save.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })
})
