import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DevicesDialog, parseHostPort, probeMessage } from "@/components/DevicesDialog"

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn(), switchDevice: vi.fn() }))

vi.mock("@/lib/auth", () => ({ hubFetch: mocks.hubFetch }))
vi.mock("@/lib/device", () => ({
  LOCAL_DEVICE_ID: "local",
  getActiveDeviceId: () => "local",
  recordDeviceConnectionRevision: vi.fn(),
  switchDevice: mocks.switchDevice,
}))

/** Route hub requests by URL + method. `probe`/`add` are overridable per test. */
function routeHub(options: {
  devices?: unknown[]
  probe?: unknown
  add?: { body: unknown; ok?: boolean; status?: number }
  update?: { body: unknown; ok?: boolean; status?: number }
  remove?: Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
}) {
  const { devices = [], probe, add, update, remove } = options
  mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/hub/devices" && init?.method === "POST") {
      return Promise.resolve({
        ok: add?.ok ?? true,
        status: add?.status ?? 201,
        json: async () => add?.body ?? { device: { id: "dev_new" } },
      })
    }
    if (url.startsWith("/api/hub/devices/") && init?.method === "PATCH") {
      return Promise.resolve({
        ok: update?.ok ?? true,
        status: update?.status ?? 200,
        json: async () => update?.body ?? { device: { id: "dev_updated" } },
      })
    }
    if (url.startsWith("/api/hub/devices/") && init?.method === "DELETE") {
      return remove ?? Promise.resolve({ ok: true, status: 204, json: async () => ({}) })
    }
    if (url === "/api/hub/devices/probe") {
      return Promise.resolve({ ok: true, status: 200, json: async () => probe })
    }
    if (url === "/api/hub/devices") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ devices }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

describe("parseHostPort", () => {
  it("splits host and port, tolerating a pasted scheme", () => {
    expect(parseHostPort("10.0.0.5:1234")).toEqual({ host: "10.0.0.5", port: 1234 })
    expect(parseHostPort("http://my-mac.local/")).toEqual({ host: "my-mac.local" })
    expect(parseHostPort("  box  ")).toEqual({ host: "box" })
  })

  it("marks a pasted https:// URL as tls", () => {
    expect(parseHostPort("https://cogpit.example.com/")).toEqual({ host: "cogpit.example.com", tls: true })
    expect(parseHostPort("https://box:8443")).toEqual({ host: "box", port: 8443, tls: true })
    // http stays plain — no tls flag
    expect(parseHostPort("http://box:19384")).toEqual({ host: "box", port: 19384 })
  })
})

describe("probeMessage", () => {
  it("maps each probe outcome to actionable copy", () => {
    expect(probeMessage({ ok: false, code: "UNREACHABLE" }, "box", 19384).text)
      .toMatch(/Can't reach box:19384/)
    expect(probeMessage({ ok: false, code: "LEGACY_NO_HELLO" }, "box", 19384).text)
      .toMatch(/too old for multi-device/)
    expect(probeMessage({ ok: false, code: "NOT_COGPIT" }, "box", 19384).text)
      .toMatch(/isn't Cogpit/)
    expect(probeMessage({ ok: false, code: "SELF_ADD" }, "box", 19384).text)
      .toMatch(/this machine/)
    expect(probeMessage({ ok: true, hello: { networkAccess: false } }, "box", 19384).text)
      .toMatch(/network access is disabled/)
    expect(probeMessage({ ok: true, hello: { configured: false } }, "box", 19384).text)
      .toMatch(/setup screen/)
    expect(probeMessage({ ok: true, hello: { name: "Studio", version: "1.0.1" } }, "box", 19384))
      .toEqual({ tone: "ok", text: 'Found Cogpit "Studio" (v1.0.1).' })
  })
})

describe("DevicesDialog", () => {
  beforeEach(() => {
    mocks.hubFetch.mockReset()
    mocks.switchDevice.mockReset()
  })

  it("shows unreachable copy from a live probe", async () => {
    routeHub({ probe: { ok: false, code: "UNREACHABLE", error: "x" } })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.type(screen.getByLabelText("Host"), "192.168.1.9")
    await user.tab() // blur → immediate probe

    expect(await screen.findByText(/Can't reach 192\.168\.1\.9:19384/)).toBeInTheDocument()
  })

  it("probes an https URL with tls and defaults the shown port to 443", async () => {
    routeHub({ probe: { ok: false, code: "UNREACHABLE", error: "x" } })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.click(screen.getByLabelText("Host"))
    await user.paste("https://cogpit.example.com")
    await user.tab() // blur → immediate probe

    expect(await screen.findByText(/Can't reach cogpit\.example\.com:443/)).toBeInTheDocument()
    const probeCall = mocks.hubFetch.mock.calls.find(([url]) => url === "/api/hub/devices/probe")
    expect(JSON.parse((probeCall![1] as RequestInit).body as string)).toMatchObject({
      host: "cogpit.example.com",
      tls: true,
    })
  })

  it("adds a device, then switches to it and closes", async () => {
    routeHub({
      probe: { ok: true, hello: { name: "Studio", version: "1.0.1", networkAccess: true, configured: true } },
      add: { body: { device: { id: "dev_new" } }, status: 201 },
    })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={onClose} />)

    await user.type(screen.getByLabelText("Host"), "10.0.0.5")
    await user.tab()
    expect(await screen.findByText(/Found Cogpit "Studio"/)).toBeInTheDocument()

    await user.type(screen.getByLabelText("Password"), "hunter2hunter2")
    await user.click(screen.getByRole("button", { name: "Add device" }))

    await waitFor(() => expect(mocks.switchDevice).toHaveBeenCalledWith("dev_new"))
    expect(onClose).toHaveBeenCalled()
  })

  it("detects a team device, requires its username, and sends named credentials", async () => {
    routeHub({
      probe: {
        ok: true,
        hello: {
          name: "Team Studio",
          version: "1.0.1",
          edition: "team",
          networkAccess: false,
          configured: true,
        },
      },
      add: { body: { device: { id: "dev_team", username: "alice" } }, status: 201 },
    })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.type(screen.getByLabelText("Host"), "10.0.0.8")
    await user.tab()
    expect(await screen.findByText(/Found Cogpit "Team Studio"/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add device" })).toBeDisabled()

    await user.type(screen.getByLabelText("Username"), " Alice ")
    await user.type(screen.getByLabelText("Password"), "member-password-1")
    await user.click(screen.getByRole("button", { name: "Add device" }))

    const addCall = mocks.hubFetch.mock.calls.find(
      ([url, init]) => url === "/api/hub/devices" && init?.method === "POST",
    )
    expect(JSON.parse((addCall![1] as RequestInit).body as string)).toMatchObject({
      host: "10.0.0.8",
      username: "Alice",
      password: "member-password-1",
    })
  })

  it("keeps add disabled while a team device still needs its first admin", async () => {
    routeHub({
      probe: {
        ok: true,
        hello: { name: "Fresh Team", edition: "team", needsBootstrap: true, configured: false },
      },
    })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.type(screen.getByLabelText("Host"), "10.0.0.10")
    await user.tab()
    expect(await screen.findByText(/create its first admin account/i)).toBeInTheDocument()
    await user.type(screen.getByLabelText("Username"), "founder")
    await user.type(screen.getByLabelText("Password"), "founder-password-1")

    expect(screen.getByRole("button", { name: "Add device" })).toBeDisabled()
    expect(mocks.hubFetch.mock.calls.some(
      ([url, init]) => url === "/api/hub/devices" && init?.method === "POST",
    )).toBe(false)
  })

  it("edits a stored team account without ever exposing its password", async () => {
    const device = {
      id: "dev_team",
      name: "Team Studio",
      host: "10.0.0.8",
      port: 19384,
      auth: "password",
      username: "alice",
      addedAt: 1,
      runtime: { authState: "ok", lastHello: { edition: "team", version: "1.0.1" } },
    }
    routeHub({ devices: [device], update: { body: { device: { ...device, username: "bob" } } } })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="manage" onClose={vi.fn()} />)

    expect(await screen.findByText("Team account: alice")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Edit account for Team Studio" }))
    const passwordInput = screen.getByLabelText("New password for Team Studio")
    expect(passwordInput).toHaveValue("")

    const usernameInput = screen.getByLabelText("Username for Team Studio")
    await user.clear(usernameInput)
    await user.type(usernameInput, "bob")
    await user.type(passwordInput, "bob-password-1")
    await user.click(screen.getByRole("button", { name: "Save account" }))

    const patchCall = mocks.hubFetch.mock.calls.find(
      ([url, init]) => url === "/api/hub/devices/dev_team" && init?.method === "PATCH",
    )
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
      username: "bob",
      password: "bob-password-1",
    })
  })

  it("sends null to clear a stored team username", async () => {
    const device = {
      id: "dev_team",
      name: "Team Studio",
      host: "10.0.0.8",
      port: 19384,
      auth: "password",
      username: "alice",
      addedAt: 1,
      runtime: { authState: "ok", lastHello: { edition: "team" } },
    }
    routeHub({ devices: [device], update: { body: { device: { ...device, username: undefined } } } })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="manage" onClose={vi.fn()} />)

    await screen.findByText("Team account: alice")
    await user.click(screen.getByRole("button", { name: "Edit account for Team Studio" }))
    await user.clear(screen.getByLabelText("Username for Team Studio"))
    await user.click(screen.getByRole("button", { name: "Save account" }))

    const patchCall = mocks.hubFetch.mock.calls.find(
      ([url, init]) => url === "/api/hub/devices/dev_team" && init?.method === "PATCH",
    )
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ username: null })
  })

  it("confirms device removal in an alert dialog and waits for the request", async () => {
    const device = {
      id: "dev_studio",
      name: "Studio",
      host: "10.0.0.5",
      port: 19384,
      auth: "none",
      addedAt: 1,
      runtime: { authState: "ok", lastHello: { version: "1.0.1" } },
    }
    let finishRemove: (() => void) | undefined
    const remove = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(
      (resolve) => {
        finishRemove = () => resolve({ ok: true, status: 204, json: async () => ({}) })
      },
    )
    routeHub({ devices: [device], remove })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="manage" onClose={vi.fn()} />)

    await screen.findByText("Studio")
    expect(screen.getByText("Unauthenticated")).toHaveAttribute("data-slot", "badge")
    await user.click(screen.getByRole("button", { name: "Remove Studio" }))

    expect(screen.getByRole("alertdialog", { name: "Remove Studio?" })).toBeInTheDocument()
    expect(mocks.hubFetch.mock.calls.some(
      ([url, init]) => url === "/api/hub/devices/dev_studio" && init?.method === "DELETE",
    )).toBe(false)

    const confirm = screen.getByRole("button", { name: "Remove device" })
    await user.click(confirm)
    expect(confirm).toBeDisabled()
    expect(screen.getByRole("alertdialog", { name: "Remove Studio?" })).toBeInTheDocument()

    finishRemove?.()
    await waitFor(() => expect(confirm).toBeEnabled())
  })

  it("maps a rejected password to an inline field error", async () => {
    routeHub({
      probe: { ok: true, hello: { name: "Studio", networkAccess: true, configured: true } },
      add: { body: { error: "The password was rejected by the device.", code: "BAD_PASSWORD" }, ok: false, status: 400 },
    })
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.type(screen.getByLabelText("Host"), "10.0.0.5")
    await user.tab()
    await screen.findByText(/Found Cogpit/)
    await user.type(screen.getByLabelText("Password"), "wrong-pass-1")
    await user.click(screen.getByRole("button", { name: "Add device" }))

    expect(await screen.findByText(/password was rejected/)).toBeInTheDocument()
    expect(mocks.switchDevice).not.toHaveBeenCalled()
  })

  it("reveals the tunnel warning and hides the password field", async () => {
    routeHub({})
    const user = userEvent.setup()
    render(<DevicesDialog open initialMode="add" onClose={vi.fn()} />)

    await user.click(screen.getByRole("checkbox", { name: /local tunnel/ }))

    expect(screen.getByText(/forwarded/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
  })
})
