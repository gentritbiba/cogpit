// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { libraryHome, stopLibrary, syncLibraryFrom } from "../../library"
import { LibraryStore } from "../../library/store"
import { makeSession, openMemoryStore, sourceFile } from "../memory/helpers"

const cleanups: Array<() => void> = []
afterEach(async () => {
  await stopLibrary()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("library runtime", () => {
  it("sits beside the memory store it is fed from, unless told otherwise", () => {
    expect(libraryHome({ COGPIT_MEMORY_DIR: "/qa/run/memory" })).toBe(join("/qa/run", "library"))
    expect(libraryHome({ COGPIT_MEMORY_DIR: "/qa/run/memory", COGPIT_LIBRARY_HOME: "/elsewhere" })).toBe("/elsewhere")
    expect(libraryHome({ HOME: "/home/me" })).toMatch(/[\\/]\.cogpit[\\/]library$/)
  })

  it("stops reading at the next batch when stopped, so a shutdown does not wait for a whole catch-up", async () => {
    const home = mkdtempSync(join(tmpdir(), "cogpit-library-runtime-"))
    vi.stubEnv("COGPIT_LIBRARY_HOME", home)
    const memory = openMemoryStore()
    cleanups.push(() => memory.close(), () => rmSync(home, { recursive: true, force: true }))
    for (let index = 0; index < 60; index++) {
      memory.syncSession(sourceFile({ path: `/t/${index}.jsonl`, sessionId: `s-${index}` }), makeSession([{ user: "a", assistant: `https://${index}.dev` }], { sessionId: `s-${index}` }))
    }

    const syncing = syncLibraryFrom(memory)
    await stopLibrary()
    await syncing

    const library = LibraryStore.open(new DatabaseSync(join(home, "library.db")))
    cleanups.unshift(() => library.close())
    expect(library.sourceStates().size).toBe(25)
  })
})
