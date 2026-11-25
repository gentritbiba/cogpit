import { cleanup, render } from "@testing-library/react"
import { Activity } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

const runtime = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock("../runtimeFrame", () => ({
  createRuntimeFrame: (options: unknown) => {
    runtime.create(options)
    return { dispose: runtime.dispose, setActive: vi.fn(), updateContext: vi.fn(), notifyDrafts: vi.fn() }
  },
}))

import { PluginFrame } from "../PluginFrame"
import { createPaneLifetime, PaneLifetimeProvider } from "@/contexts/DevicePaneContext"

const payload = new ArrayBuffer(4)
const context = { project: null } as never

function Frame({ hidden, lifetime }: { hidden: boolean; lifetime: ReturnType<typeof createPaneLifetime> }) {
  return (
    <PaneLifetimeProvider value={lifetime}>
      <Activity mode={hidden ? "hidden" : "visible"}>
        <PluginFrame payload={payload} digest="d1" activationKey="a1" context={context} execute={vi.fn()} />
      </Activity>
    </PaneLifetimeProvider>
  )
}

afterEach(async () => {
  cleanup()
  // A frame leaving the page goes once the commit is done.
  await Promise.resolve()
  runtime.create.mockClear()
  runtime.dispose.mockClear()
})

describe("PluginFrame in a machine's pane", () => {
  it("keeps the frame running while the pane is hidden, without loading it again", async () => {
    const lifetime = createPaneLifetime()
    const { rerender } = render(<Frame hidden={false} lifetime={lifetime} />)
    rerender(<Frame hidden lifetime={lifetime} />)
    await Promise.resolve()
    rerender(<Frame hidden={false} lifetime={lifetime} />)
    await Promise.resolve()
    expect(runtime.create).toHaveBeenCalledOnce()
    expect(runtime.dispose).not.toHaveBeenCalled()
  })

  it("lets the frame go when it leaves the page", async () => {
    const lifetime = createPaneLifetime()
    const { unmount } = render(<Frame hidden={false} lifetime={lifetime} />)
    unmount()
    await Promise.resolve()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it("lets a frame kept through a hidden pane go when the pane ends", async () => {
    const lifetime = createPaneLifetime()
    const { rerender } = render(<Frame hidden={false} lifetime={lifetime} />)
    rerender(<Frame hidden lifetime={lifetime} />)
    await Promise.resolve()
    lifetime.end()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })
})
