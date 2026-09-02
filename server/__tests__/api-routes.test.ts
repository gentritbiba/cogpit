// @vitest-environment node

import { describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../helpers"

vi.mock("../lib/leakReaper", () => ({
  getRecentlyReaped: vi.fn(() => []),
  killPids: vi.fn(() => []),
  startLeakReaper: vi.fn(),
}))

import { API_ROUTE_REGISTRY, registerApiRoutes } from "../api-routes"
import { ROUTE_POLICIES } from "../team/policy"
import type { HubMode } from "../routes/hello"

const CANONICAL_ROUTE_IDS = [
  "hello",
  "devices",
  "hub",
  "performance",
  "config",
  "team-admin",
  "projects",
  "session-send",
  "session-new",
  "session-manage",
  "ports",
  "teams",
  "team-session",
  "workflows",
  "undo",
  "files",
  "files-watch",
  "session-file-changes",
  "session-config",
  "session-context",
  "session-status",
  "shares",
  "share-guest",
  "editor",
  "worktrees",
  "usage",
  "usage-cost",
  "slash-suggestions",
  "config-browser",
  "local-file",
  "file-content",
  "project-files",
  "project-file",
  "git-status",
  "github-actions",
  "project-icon",
  "git-diff",
  "mcp",
  "notifications",
  "scripts",
  "permissions",
  "mission-control",
  "ask-user",
  "copilot-history",
  "agent-prompts",
  "models",
  "codex-threads",
  "agent-runtime",
  "provider-updates",
  "agent-executable",
] as const

function captureRegistrations(mode: HubMode): Array<{
  path: string
  handler: Middleware
}> {
  const registrations: Array<{ path: string; handler: Middleware }> = []
  const use: UseFn = (path, handler) => registrations.push({ path, handler })
  registerApiRoutes(use, { mode })
  return registrations
}

describe("API route registry", () => {
  it("has unique IDs in the documented canonical order", () => {
    const ids = API_ROUTE_REGISTRY.map(({ id }) => id)

    expect(ids).toEqual(CANONICAL_ROUTE_IDS)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("registers identical middleware paths in dev, Electron, and standalone modes", () => {
    const pathsFor = (mode: HubMode) =>
      captureRegistrations(mode).map(({ path }) => path)
    const devPaths = pathsFor("dev")

    expect(pathsFor("electron")).toEqual(devPaths)
    expect(pathsFor("standalone")).toEqual(devPaths)
    expect(devPaths.filter((path) => path === "/hub")).toHaveLength(1)
  })

  it.each<HubMode>(["dev", "electron", "standalone"])(
    "forwards the %s platform mode to the hello route",
    (mode) => {
      const hello = captureRegistrations(mode).find(
        ({ path }) => path === "/api/hello",
      )
      expect(hello).toBeDefined()

      let body = ""
      hello?.handler(
        { method: "GET" } as never,
        {
          setHeader: vi.fn(),
          end: (value: string) => {
            body = value
          },
        } as never,
        vi.fn(),
      )

      expect(JSON.parse(body)).toMatchObject({ app: "cogpit", mode })
    },
  )

  it("forwards a rejected async route through the shared error boundary", async () => {
    const worktrees = captureRegistrations("dev").find(
      ({ path }) => path === "/api/worktrees",
    )
    expect(worktrees).toBeDefined()
    const next = vi.fn()

    worktrees?.handler(
      { method: "GET", url: "/%" } as never,
      {} as never,
      next,
    )

    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    expect(next.mock.calls[0][0]).toBeInstanceOf(URIError)
  })
})

describe("team route policies", () => {
  const registryIds = API_ROUTE_REGISTRY.map(({ id }) => id)

  it("covers every registry id with at least one policy rule", () => {
    for (const id of registryIds) {
      const rules = ROUTE_POLICIES[id]
      expect(rules, `route id "${id}" has no policy entry`).toBeDefined()
      expect(rules?.length, `route id "${id}" has an empty policy entry`).toBeGreaterThan(0)
    }
  })

  it("has no policy entries for ids missing from the registry", () => {
    const known = new Set<string>(registryIds)
    for (const id of Object.keys(ROUTE_POLICIES)) {
      expect(known.has(id), `policy entry "${id}" is not a registry id`).toBe(true)
    }
  })
})
