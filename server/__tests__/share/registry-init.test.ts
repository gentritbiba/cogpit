// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ViteDevServer } from "vite"

// Both shells are booted for real; the registry modules are only wrapped so the
// directory each shell hands them is observable. Spreading the original keeps
// every other export (and all of the persistence behaviour) live.
const { deviceRegistryDirs, shareRegistryDirs } = vi.hoisted(() => ({
  deviceRegistryDirs: [] as string[],
  shareRegistryDirs: [] as string[],
}))

vi.mock("../../hub/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hub/registry")>()
  return {
    ...actual,
    initDeviceRegistry: async (dir: string) => {
      deviceRegistryDirs.push(dir)
      await actual.initDeviceRegistry(dir)
    },
  }
})

vi.mock("../../share/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../share/registry")>()
  return {
    ...actual,
    initShareRegistry: async (dir: string) => {
      shareRegistryDirs.push(dir)
      await actual.initShareRegistry(dir)
    },
  }
})

import { createServerComposition } from "../../app-server"
import { sessionApiPlugin } from "../../api-plugin"
import { createShare } from "../../share/registry"
import { setConfigPath } from "../../config"
import { __resetEditionForTest } from "../../team/edition"
import { cleanupProcesses } from "../../processRegistry"
import { codexAppServer } from "../../codex-app-server"

let fixtureRoot: string
let staticDir: string
let userDataDir: string

beforeEach(async () => {
  deviceRegistryDirs.length = 0
  shareRegistryDirs.length = 0
  fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-share-init-"))
  staticDir = join(fixtureRoot, "static")
  userDataDir = join(fixtureRoot, "user-data")
  await Promise.all([
    mkdir(staticDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ])
  setConfigPath(join(userDataDir, "config.local.json"))
})

afterEach(async () => {
  __resetEditionForTest()
  await rm(fixtureRoot, { recursive: true, force: true })
})

describe("share registry initialization parity", () => {
  it("initializes the share registry from the Electron/standalone composition", async () => {
    const { dispose } = await createServerComposition(staticDir, userDataDir, {
      mode: "standalone",
    })
    try {
      expect(shareRegistryDirs).toHaveLength(1)
      // A share registry pointed anywhere but the shell's data directory reads
      // an empty file at startup and every existing share silently vanishes.
      expect(shareRegistryDirs[0]).toBe(deviceRegistryDirs[0])
      expect(shareRegistryDirs[0]).toBe(userDataDir)

      // Proves the registry is actually live: an uninitialized one throws on
      // the first mutation instead of persisting.
      await createShare({
        sessionId: "sess-1",
        dirName: "-Users-me-proj",
        fileName: "sess-1.jsonl",
      })
      await expect(stat(join(userDataDir, "shares.local.json"))).resolves.toBeDefined()
    } finally {
      await dispose()
    }
  })

  it("initializes the share registry from the Vite dev plugin", async () => {
    const configureServer = sessionApiPlugin().configureServer
    if (typeof configureServer !== "function") {
      throw new Error("Expected a configureServer hook")
    }

    try {
      await configureServer({
        httpServer: { on: () => {} },
        middlewares: { use: () => {} },
      } as unknown as ViteDevServer)

      expect(shareRegistryDirs).toHaveLength(1)
      expect(shareRegistryDirs[0]).toBe(deviceRegistryDirs[0])
    } finally {
      await Promise.all([cleanupProcesses(), codexAppServer.shutdown()])
    }
  })
})
