import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { BackgroundServers } from "../BackgroundServers"

const DEV_SERVER = {
  id: "task-1",
  outputPath: "/tmp/task-1.log",
  ports: [5173],
  portStatus: { 5173: true },
  preview: "vite dev --port 5173",
}

async function renderServers(canStop?: boolean) {
  await act(async () => {
    render(<BackgroundServers cwd="/work/app" turns={[]} canStop={canStop} />)
  })
}

describe("BackgroundServers", () => {
  beforeEach(() => {
    mocks.authFetch.mockImplementation(async (url: string) => new Response(
      JSON.stringify(url.startsWith("/api/background-tasks") ? [DEV_SERVER] : {}),
    ))
  })

  afterEach(() => mocks.authFetch.mockReset())

  it("offers to stop a running server to a user who may stop this session's processes", async () => {
    await renderServers(true)

    await act(async () => screen.getByRole("button", { name: "Stop server" }).click())

    expect(mocks.authFetch).toHaveBeenCalledWith("/api/kill-port", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ port: 5173 }),
    }))
  })

  it("lists the server without Stop for anyone else", async () => {
    await renderServers()

    expect(screen.getByText("Active Servers (1)")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop server" })).not.toBeInTheDocument()
  })
})
