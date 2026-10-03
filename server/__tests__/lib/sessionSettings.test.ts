// @vitest-environment node
import type { IncomingMessage } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentTurnSettings } from "../../agents/runtimeTypes"
import { dirs } from "../../dirs"
import { __resetEditionForTest, type EditionSessionSettings } from "../../edition"
import { readSessionConfig, sessionConfigKey, updateSessionConfig } from "../../lib/sessionConfigStore"
import { heldLiveUpdate, settleTurnSettings, storeAppliedSettings, writeSessionConfig } from "../../lib/sessionSettings"
import { installFakeEdition } from "../edition/fakeEdition"

const SESSION = "5e000000-0000-4000-8000-0000000005e7"
const KEY = sessionConfigKey(SESSION)
const REQ = {} as IncomingMessage
const REF = { sessionId: SESSION, agent: "claude" } as const
const SENT = { message: "hi", model: "stale", permissions: { mode: "bypassPermissions", allowedTools: ["Read"] } }

let root: string
let previousConfigDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-session-settings-"))
  previousConfigDir = dirs.SESSION_CONFIG_DIR
  dirs.SESSION_CONFIG_DIR = join(root, "session-config")
})

afterEach(async () => {
  dirs.SESSION_CONFIG_DIR = previousConfigDir
  __resetEditionForTest()
  await rm(root, { recursive: true, force: true })
})

describe("the session config store", () => {
  it("keeps every field of writes to one key that overlap", async () => {
    await Promise.all(["model", "effort", "fastMode"].map((field) => updateSessionConfig(KEY, () => ({ [field]: field }))))

    expect(await readSessionConfig(KEY)).toEqual({ model: "model", effort: "effort", fastMode: "fastMode" })
  })

  it("names the fields a write moved, a removed one included", async () => {
    await updateSessionConfig(KEY, () => ({ model: "opus", effort: "high", mcpServers: ["docs"] }))

    const update = await updateSessionConfig(KEY, () => ({ model: "opus", effort: null, mcpServers: ["docs", "web"] }))

    expect(update).toEqual({
      before: { model: "opus", effort: "high", mcpServers: ["docs"] },
      config: { model: "opus", mcpServers: ["docs", "web"] },
      changed: ["effort", "mcpServers"],
    })
  })
})

describe("personal edition", () => {
  it("sends a send's settings as they came, whatever the stored config holds", async () => {
    await updateSessionConfig(KEY, () => ({ permissionMode: "default", model: "opus" }))
    const request = { ...SENT }

    expect(await settleTurnSettings(REQ, REF, request, ["model"])).toBe(request)
    expect(await readSessionConfig(KEY)).toEqual({ permissionMode: "default", model: "opus" })
  })

  it("gives a send that leaves out the permission mode the stored one, and nothing else", async () => {
    await updateSessionConfig(KEY, () => ({ permissionMode: "acceptEdits", model: "opus" }))

    expect(await settleTurnSettings(REQ, REF, { message: "hi", permissions: { allowedTools: ["Read"] } }, [])).toEqual({
      message: "hi",
      permissions: { mode: "acceptEdits", allowedTools: ["Read"] },
    })
  })

  it("leaves a send without a permission mode as it came when none is stored", async () => {
    const request: AgentTurnSettings & { message: string } = { message: "hi" }

    expect(await settleTurnSettings(REQ, REF, request, [])).toBe(request)
  })

  it("applies a live settings update whole", () => {
    const updates = { model: "stale", effort: "high", mcpConfig: null }

    expect(heldLiveUpdate(updates, [])).toBe(updates)
  })

  it("stores nothing for a change applied to a running session", async () => {
    await storeAppliedSettings(REQ, SESSION, "claude", SENT)

    await expect(readdir(dirs.SESSION_CONFIG_DIR)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("an edition's session settings", () => {
  function install(settled?: (request: AgentTurnSettings) => AgentTurnSettings) {
    const hooks = {
      settleTurn: vi.fn(async (_req: IncomingMessage, _session: unknown, request: AgentTurnSettings) => settled ? settled(request) : request),
      holdLiveUpdate: vi.fn(() => ({ held: true })),
      storeApplied: vi.fn(async () => {}),
      onConfigWrite: vi.fn(async () => {}),
    }
    installFakeEdition({ sessionSettings: hooks as unknown as EditionSessionSettings })
    return hooks
  }

  it("runs a send with the settings the edition settles, naming the fields it changes", async () => {
    const hooks = install(() => ({ model: "opus", permissions: { mode: "plan" } }))

    expect(await settleTurnSettings(REQ, REF, SENT, ["model"])).toEqual({ model: "opus", permissions: { mode: "plan" } })
    expect(hooks.settleTurn).toHaveBeenCalledWith(REQ, REF, SENT, ["model"])
  })

  it("still gives the stored permission mode to what the edition settles without one", async () => {
    install(() => ({ model: "opus" }))
    await updateSessionConfig(KEY, () => ({ permissionMode: "acceptEdits" }))

    expect(await settleTurnSettings(REQ, REF, SENT, [])).toEqual({ model: "opus", permissions: { mode: "acceptEdits" } })
  })

  it("hands live updates and applied changes to the edition", async () => {
    const hooks = install()

    expect(heldLiveUpdate({ model: "stale" }, ["effort"])).toEqual({ held: true })
    expect(hooks.holdLiveUpdate).toHaveBeenCalledWith({ model: "stale" }, ["effort"])
    await storeAppliedSettings(REQ, SESSION, "claude", SENT)
    expect(hooks.storeApplied).toHaveBeenCalledWith(REQ, SESSION, "claude", SENT)
  })

  it("tells the edition of a write to a session's own key that moved a field, and of no other", async () => {
    const hooks = install()

    await writeSessionConfig(REQ, KEY, SESSION, { model: "opus" })
    expect(hooks.onConfigWrite).toHaveBeenCalledOnce()
    expect(hooks.onConfigWrite).toHaveBeenCalledWith(REQ, SESSION, {
      before: {},
      config: { model: "opus" },
      changed: ["model"],
    })

    await writeSessionConfig(REQ, KEY, SESSION, { model: "opus" })
    await writeSessionConfig(REQ, "-Users-me-proj", null, { model: "haiku" })
    expect(hooks.onConfigWrite).toHaveBeenCalledOnce()
  })
})
