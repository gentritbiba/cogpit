import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { ConfigDialog } from "@/components/ConfigDialog"

const SAVED_CONFIG = {
  claudeDir: "/Users/me/.claude",
  agentExecutable: { source: "auto" } as Record<string, unknown>,
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
    if (url === "/api/agent-executable/claude") {
      return Promise.resolve({ ok: true, json: async () => EXECUTABLE_REPORT })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
}

const EXECUTABLE_REPORT = {
  choice: { source: "auto" },
  candidates: [
    { source: "path", path: "/Users/me/.local/bin/claude", version: "2.1.258" },
    { source: "bundled", path: "/Users/me/app/node_modules/sdk/claude", version: "2.1.245" },
  ],
  active: { source: "path", path: "/Users/me/.local/bin/claude", version: "2.1.258" },
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

describe("ConfigDialog executable picker", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
  })

  async function expandPicker(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /Claude Code executable/ }))
  }

  it("starts collapsed, summarising the choice and the running version", async () => {
    mockConfig()
    renderDialog()

    const trigger = await screen.findByRole("button", { name: /Claude Code executable/ })
    await waitFor(() => expect(trigger).toHaveTextContent("Automatic · v2.1.258"))
    expect(screen.queryByRole("radio", { name: "Automatic" })).not.toBeInTheDocument()
  })

  it("lists each detected binary with its version and what is running now", async () => {
    const user = userEvent.setup()
    mockConfig()
    renderDialog()
    await expandPicker(user)

    await waitFor(() => expect(screen.getByText(/Now running: v2\.1\.258/)).toBeInTheDocument())
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked()
    expect(screen.getByText("v2.1.245 · /Users/me/app/node_modules/sdk/claude")).toBeInTheDocument()
    // Nothing behind the npm option on this machine, so it cannot be picked.
    expect(screen.getByRole("radio", { name: "Global npm install" })).toBeDisabled()
    expect(screen.getByText("Not found on this machine.")).toBeInTheDocument()
  })

  it("saves the picked source", async () => {
    const user = userEvent.setup()
    mockConfig()
    const { onSaved } = renderDialog()
    await expandPicker(user)

    await waitFor(() => expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked())
    await user.click(screen.getByRole("radio", { name: "Bundled with Cogpit" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const save = mocks.authFetch.mock.calls.find((call) => call[1]?.method === "POST")
    expect(JSON.parse(save?.[1]?.body as string)).toMatchObject({
      agentExecutable: { source: "bundled" },
    })
  })

  it("will not save a custom source without a path", async () => {
    const user = userEvent.setup()
    mockConfig()
    renderDialog()
    await expandPicker(user)

    await waitFor(() => expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked())
    await user.click(screen.getByRole("radio", { name: "Custom path" }))
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()

    await user.type(screen.getByLabelText("Claude Code executable path"), "/opt/claude")
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("keeps a saved npm choice selectable even when the shim has gone", async () => {
    const user = userEvent.setup()
    mockConfig({ agentExecutable: { source: "npm" } })
    renderDialog()
    await expandPicker(user)

    await waitFor(() => expect(screen.getByRole("radio", { name: "Global npm install" })).toBeChecked())
    expect(screen.getByRole("radio", { name: "Global npm install" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })
})
