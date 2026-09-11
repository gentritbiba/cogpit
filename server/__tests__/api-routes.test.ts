// @vitest-environment node

import { readFileSync } from "node:fs"
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
  "session-archive",
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
  "github",
  "vercel-deployments",
  "clickup",
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
  "agent-accounts",
  "browser",
] as const

/** Every `./routes/*` module api-routes.ts imports, with the names it imports. */
const ROUTE_MODULES = [
  ...readFileSync(new URL("../api-routes.ts", import.meta.url), "utf8").matchAll(
    /import\s*{([^}]*)}\s*from\s*"\.\/(routes\/[a-z0-9-]+)"/g,
  ),
].map(([, names, specifier]) => ({
  specifier,
  exports: names
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.startsWith("type ")),
}))

interface RegistrarCall {
  registrar: string
  args: unknown[]
}

/** Module namespace whose every export is a spy recording how it was called. */
function spyNamespace(names: string[], calls: RegistrarCall[]) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) => {
        calls.push({ registrar: name, args })
      },
    ]),
  )
}

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

  it("hands every registrar `use` alone, never the shared context", async () => {
    expect(ROUTE_MODULES.length, "route module scan found nothing").toBeGreaterThan(50)
    const calls: RegistrarCall[] = []
    const context = { mode: "dev" as HubMode }
    const noopUse: UseFn = () => {}

    vi.resetModules()
    for (const { specifier, exports } of ROUTE_MODULES) {
      vi.doMock(`../${specifier}`, () => spyNamespace(exports, calls))
    }

    try {
      const { API_ROUTE_REGISTRY: registry } = await import("../api-routes")

      for (const route of registry) {
        calls.length = 0
        route.register(noopUse, context)

        if (route.id === "hub") {
          expect(calls, '"hub" registers inline and calls no registrar').toHaveLength(0)
          continue
        }

        const [call] = calls
        expect(call, `route "${route.id}" registered nothing`).toBeDefined()
        if (!call) continue

        if (route.id === "hello") {
          expect(call.args, `"hello" needs the platform mode`).toEqual([noopUse, context])
          continue
        }

        expect(
          call.args,
          `route "${route.id}" called ${call.registrar}() with ${call.args.length} arguments instead of 1. ` +
            "Wrap it in apiRoute() in server/api-routes.ts: registrars whose second parameter is an " +
            "injected dependency (github, clickup, vercel-deployments, permissions, codex-threads, " +
            "copilot-history, browser, ask-user) receive ApiRouteContext as their dependencies and " +
            "break at request time, with types and every other test still green.",
        ).toEqual([noopUse])
      }
    } finally {
      for (const { specifier } of ROUTE_MODULES) vi.doUnmock(`../${specifier}`)
      vi.resetModules()
    }
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
