// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

// The performance route starts the leak reaper at registration time.
vi.mock("../../lib/leakReaper", () => ({
  getRecentlyReaped: vi.fn(() => []),
  killPids: vi.fn(() => []),
  startLeakReaper: vi.fn(),
}))

import { registerApiRoutes } from "../../api-routes"
import type { UseFn } from "../../http"
import type { HubMode } from "../../routes/hello"
import { shareRequestAllowed, type ShareScope } from "../../share/allowlist"

const SHARE: ShareScope = {
  sessionId: "sess-1",
  dirName: "-Users-me-proj",
  fileName: "sess-1.jsonl",
}

/** A second share, to prove the rules compare identity rather than shape. */
const OTHER_SHARE: ShareScope = {
  sessionId: "sess-2",
  dirName: "-Users-me-other",
  fileName: "sess-2.jsonl",
}

const HUB_MODES: readonly HubMode[] = ["dev", "electron", "standalone"]

/**
 * Every method the allowlist could ever be asked about: the four the API uses,
 * the three a browser or proxy can send unprompted, and one that is not a verb
 * at all. Anything the allowlist does not name by hand must fall through to
 * denied.
 */
const METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "BREW",
] as const

/**
 * Every path the server mounts, collected by running the real composition root
 * with a fake `use`. `registerApiRoutes` rather than `API_ROUTE_REGISTRY`,
 * because it is what the Vite, Electron and standalone shells all call: it
 * covers the registry plus anything mounted alongside it, and route modules
 * that call `use` several times or mount nested paths are captured by
 * construction. Every hub mode is registered, so a route that only exists in
 * one shell still shows up.
 */
function mountedPaths(): string[] {
  const paths = new Set<string>()
  for (const mode of HUB_MODES) {
    const use: UseFn = (path) => {
      paths.add(path)
    }
    registerApiRoutes(use, { mode })
  }
  return [...paths].sort()
}

/**
 * The complete set of mount prefixes a share guest may reach. Adding a path
 * here widens what a guest can do to the host machine — justify it in review.
 *
 * The guest namespace `/api/share` belongs here too, but only once it is
 * mounted; until then listing it would leave a stale entry behind, which the
 * "actually mounted" test exists to prevent.
 */
const SHARE_REACHABLE = new Set([
  "/api/hello",
  "/api/sessions/",
  "/api/watch/",
  "/api/session-status/",
  "/api/session-file-changes/",
  "/api/session-config/",
])

/**
 * A concrete request per reachable mount, with the methods the allowlist names
 * for it. This keeps `SHARE_REACHABLE` from being a list of paths nobody has
 * checked, and keeps the denial tests below from passing because the allowlist
 * denies everything.
 */
const REACHABLE_SAMPLES: ReadonlyArray<{
  mount: string
  url: string
  methods: readonly string[]
}> = [
  { mount: "/api/hello", url: "/api/hello", methods: ["GET"] },
  {
    mount: "/api/sessions/",
    url: `/api/sessions/${SHARE.dirName}/${SHARE.fileName}`,
    methods: ["GET"],
  },
  {
    mount: "/api/watch/",
    url: `/api/watch/${SHARE.dirName}/${SHARE.fileName}`,
    methods: ["GET"],
  },
  {
    mount: "/api/session-status/",
    url: `/api/session-status/${SHARE.sessionId}`,
    methods: ["GET"],
  },
  {
    mount: "/api/session-file-changes/",
    url: `/api/session-file-changes/${SHARE.sessionId}`,
    methods: ["GET"],
  },
  {
    mount: "/api/session-config/",
    url: `/api/session-config/${SHARE.fileName}`,
    methods: ["GET", "PUT"],
  },
]

/**
 * Suffixes appended to every denied mount. A mount is a prefix, not a path:
 * `/api/file-content` also answers `/api/file-content/anything`, so the
 * question worth asking is whether a denied mount can be dressed up to look
 * like an allowed one — with a share's own identity, with the name of an
 * allowed route, or with a traversal that resolves to one.
 */
const SUFFIXES = [
  SHARE.sessionId,
  SHARE.fileName,
  `${SHARE.dirName}/${SHARE.fileName}`,
  "hello",
  `session-status/${SHARE.sessionId}`,
  `sessions/${SHARE.dirName}/${SHARE.fileName}`,
  "../hello",
  "..%2f..%2fapi%2fhello",
  `${SHARE.sessionId}?token=guest`,
  "?sessionId=sess-1",
] as const

function join(mount: string, suffix: string): string {
  if (suffix.startsWith("?")) return `${mount}${suffix}`
  return mount.endsWith("/") ? `${mount}${suffix}` : `${mount}/${suffix}`
}

/**
 * `/api` itself is mounted — the compression tap sits over the whole namespace,
 * reachable routes included — so appending suffixes to it only rebuilds the
 * allowed paths. Its bare form is still asserted denied.
 */
function coversReachableMount(path: string): boolean {
  return [...SHARE_REACHABLE].some((entry) => entry !== path && entry.startsWith(path))
}

function expectDenied(method: string, url: string, why: string): void {
  expect(shareRequestAllowed(method, url, SHARE), `${method} ${url} ${why}`).toBe(false)
}

describe("share allowlist completeness", () => {
  it("denies every mounted path that is not share-reachable", () => {
    const paths = mountedPaths()
    expect(paths.length).toBeGreaterThan(50)

    for (const path of paths) {
      if (SHARE_REACHABLE.has(path)) continue
      for (const method of METHODS) {
        expectDenied(method, path, "must be denied to a share guest")
      }
    }
  })

  it("denies mounted paths that are dressed up to look reachable", () => {
    for (const path of mountedPaths()) {
      if (SHARE_REACHABLE.has(path) || coversReachableMount(path)) continue
      for (const suffix of SUFFIXES) {
        const url = join(path, suffix)
        for (const method of METHODS) {
          expectDenied(method, url, "must be denied — the mount is not reachable")
        }
      }
    }
  })

  it("keeps SHARE_REACHABLE honest — every entry is actually mounted", () => {
    const mounted = new Set(mountedPaths())
    for (const path of SHARE_REACHABLE) {
      expect(mounted, `${path} is listed as share-reachable but nothing mounts it`)
        .toContain(path)
    }
  })

  it("keeps SHARE_REACHABLE honest — every entry has a checked sample", () => {
    const sampled = new Set(REACHABLE_SAMPLES.map(({ mount }) => mount))
    expect(sampled).toEqual(SHARE_REACHABLE)
  })

  it("lets the guest reach its own session on the reachable mounts", () => {
    for (const { url, methods } of REACHABLE_SAMPLES) {
      for (const method of methods) {
        expect(
          shareRequestAllowed(method, url, SHARE),
          `${method} ${url} must be allowed for the share that owns it`,
        ).toBe(true)
      }
    }
  })

  it("denies methods the reachable mounts do not name", () => {
    for (const { url, methods } of REACHABLE_SAMPLES) {
      for (const method of METHODS) {
        if (methods.includes(method)) continue
        expectDenied(method, url, "must be denied — the mount does not name that method")
      }
    }
  })

  it("denies the reachable mounts to a share that does not own the session", () => {
    for (const { mount, url, methods } of REACHABLE_SAMPLES) {
      // /api/hello carries no identity, so it is reachable by any guest.
      if (mount === "/api/hello") continue
      for (const method of methods) {
        expect(
          shareRequestAllowed(method, url, OTHER_SHARE),
          `${method} ${url} must be denied to a guest of another session`,
        ).toBe(false)
      }
    }
  })

  it("denies a route that does not exist yet", () => {
    // Stand-ins for whatever gets mounted next: names near a reachable one,
    // names that merely start with it, names from nowhere.
    const futureMounts = [
      "/api/exec",
      "/api/sessions-export/",
      "/api/session-status-all",
      "/api/hello-world",
      "/api/share-admin/",
      "/api/watch2/",
      "/api/v2/sessions/",
    ]
    for (const path of futureMounts) {
      expect(mountedPaths(), `${path} is mounted — pick a name that is not`)
        .not.toContain(path)
      for (const method of METHODS) {
        expectDenied(method, path, "must be denied — a new route is denied by default")
        for (const suffix of SUFFIXES) {
          expectDenied(
            method,
            join(path, suffix),
            "must be denied — a new route is denied by default",
          )
        }
      }
    }
  })
})
