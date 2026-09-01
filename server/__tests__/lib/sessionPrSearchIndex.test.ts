// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetSessionPrIndex } from "../../lib/sessionPrIndex"
import {
  getSessionPrSearchSnapshot,
  resetSessionPrSearchIndex,
} from "../../lib/sessionPrSearchIndex"
import { dirs } from "../../sessionPaths"

let dir: string
let file: string
let previousConfigDir: string

function command(value: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: value } }],
    },
  })
}

function candidate() {
  const fileStat = statSync(file)
  return { filePath: file, size: fileStat.size, mtimeMs: fileStat.mtimeMs }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-search-index-"))
  file = join(dir, "session.jsonl")
  previousConfigDir = dirs.SESSION_CONFIG_DIR
  dirs.SESSION_CONFIG_DIR = dir
  resetSessionPrIndex()
  resetSessionPrSearchIndex()
})

afterEach(() => {
  resetSessionPrSearchIndex()
  resetSessionPrIndex()
  dirs.SESSION_CONFIG_DIR = previousConfigDir
  rmSync(dir, { recursive: true, force: true })
})

describe("getSessionPrSearchSnapshot", () => {
  it("indexes transcripts in the background and reloads the durable result", async () => {
    writeFileSync(file, `${command("gh pr view 157 --repo honest-cms/site")}\n`)

    const initial = await getSessionPrSearchSnapshot([candidate()])
    expect(initial.pending).toBe(1)
    expect(initial.byFile.size).toBe(0)

    await vi.waitFor(async () => {
      const completed = await getSessionPrSearchSnapshot([candidate()])
      expect(completed.pending).toBe(0)
      expect(completed.byFile.get(file)?.references).toEqual([
        { number: 157, repo: "honest-cms/site" },
      ])
    })

    const persisted = JSON.parse(readFileSync(join(dir, "pr-search-index.json"), "utf-8"))
    expect(persisted.entries).toHaveLength(1)

    resetSessionPrSearchIndex()
    resetSessionPrIndex()

    const reloaded = await getSessionPrSearchSnapshot([candidate()])
    expect(reloaded.pending).toBe(0)
    expect(reloaded.byFile.get(file)?.references[0]?.number).toBe(157)
  })
})
