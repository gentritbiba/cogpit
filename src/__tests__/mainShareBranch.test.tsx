import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/components/DeviceRoot.tsx", () => ({
  DeviceRoot: () => <div data-testid="device-root" />,
}))
vi.mock("@/components/SharedSession/SharedRoot.tsx", () => ({
  SharedRoot: () => <div data-testid="shared-root" />,
}))
vi.mock("../index.css", () => ({}))

async function boot(pathname: string): Promise<string> {
  history.pushState({}, "", pathname)
  const root = document.createElement("div")
  root.id = "root"
  document.body.appendChild(root)
  vi.resetModules()
  await import("../main")
  await new Promise((resolve) => setTimeout(resolve, 0))
  return root.innerHTML
}

describe("app root", () => {
  beforeEach(() => { document.body.innerHTML = "" })
  afterEach(() => {
    document.body.innerHTML = ""
    history.pushState({}, "", "/")
  })

  it("mounts the guest shell on a share path", async () => {
    expect(await boot("/shared/sess-1")).toContain("shared-root")
  })

  it("mounts the normal app everywhere else", async () => {
    expect(await boot("/")).toContain("device-root")
  })

  it("does not treat a hub device path as a share", async () => {
    expect(await boot("/d/laptop/shared/sess-1")).toContain("device-root")
  })
})
