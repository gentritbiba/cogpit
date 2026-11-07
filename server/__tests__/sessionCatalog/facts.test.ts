// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dirs } from "../../dirs"
import {
  factsFor,
  isCurrent,
  isStillTrue,
  pruneFactsUnder,
  recordFact,
  resetFacts,
  saveFacts,
  startFactPersistence,
} from "../../sessionCatalog/facts"
import type { SessionMeta } from "../../agents/types"

let configDir: string
const previousConfigDir = dirs.SESSION_CONFIG_DIR

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "catalog-facts-"))
  dirs.SESSION_CONFIG_DIR = configDir
  resetFacts()
})

afterEach(() => {
  resetFacts()
  dirs.SESSION_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

const savedPath = () => join(configDir, "session-catalog.json")

function meta(prompt: string): SessionMeta {
  return {
    sessionId: "s", version: "", gitBranch: "main", model: "", slug: "", name: "", aiTitle: "t", customTitle: "",
    cwd: "/w", firstUserMessage: prompt, lastUserMessage: prompt, timestamp: "", lastTimestamp: "", turnCount: 1,
    lineCount: 1, teamName: "", agentName: "", isSubagent: false, parentSessionId: null,
  }
}

describe("saved session catalog", () => {
  it("round-trips facts through an owner-only file, one compact line per file", async () => {
    await startFactPersistence()
    recordFact("/t/a.jsonl", "row", { meta: meta("short"), status: { status: "idle" }, mtimeMs: 10, size: 20 })
    recordFact("/t/a.jsonl", "identity", {
      identity: { sessionId: "a", cwd: "/w", gitBranch: "", isSubagent: false, parentSessionId: null },
      final: true, mtimeMs: 10, size: 20, sidecars: "1:2",
    })
    recordFact("/t/b.jsonl", "project", { path: "/w", final: true, mtimeMs: 1, size: 1 })
    await saveFacts()
    expect(statSync(savedPath()).mode & 0o777).toBe(0o600)
    const lines = readFileSync(savedPath(), "utf-8").split("\n")
    expect(lines).toHaveLength(3)
    expect(lines.every((line) => !line.includes("\n  "))).toBe(true)

    resetFacts()
    await startFactPersistence()
    expect(factsFor("/t/a.jsonl")?.row?.meta.firstUserMessage).toBe("short")
    expect(factsFor("/t/a.jsonl")?.identity).toMatchObject({ final: true, sidecars: "1:2" })
    expect(factsFor("/t/b.jsonl")?.project?.path).toBe("/w")
  })

  it("caps a row's prompts in memory as on disk", async () => {
    const kept = recordFact("/t/a.jsonl", "row", { meta: meta("p".repeat(5000)), status: { status: "idle" }, mtimeMs: 10, size: 20 })
    expect(kept.meta.firstUserMessage).toHaveLength(2000)
    expect(factsFor("/t/a.jsonl")?.row?.meta.lastUserMessage).toHaveLength(2000)
  })

  it("does not write when nothing changed since the last save", async () => {
    await startFactPersistence()
    recordFact("/t/a.jsonl", "project", { path: "/w", final: true, mtimeMs: 1, size: 1 })
    await saveFacts()
    rmSync(savedPath())
    await saveFacts()
    expect(() => statSync(savedPath())).toThrow()
    recordFact("/t/a.jsonl", "project", { path: "/w2", final: true, mtimeMs: 2, size: 2 })
    await saveFacts()
    expect(statSync(savedPath()).size).toBeGreaterThan(0)
  })

  it("keeps the other files when one saved line is torn", async () => {
    writeFileSync(savedPath(), [
      JSON.stringify({ revision: 2 }),
      JSON.stringify(["/t/a.jsonl", { project: { path: "/w", final: true, mtimeMs: 1, size: 1 } }]),
      "[\"/t/b.jsonl\", {\"proj",
    ].join("\n"))
    await startFactPersistence()
    expect(factsFor("/t/a.jsonl")?.project?.path).toBe("/w")
    expect(factsFor("/t/b.jsonl")).toBeUndefined()
  })

  it("discards a file another reader revision wrote, and one that does not parse", async () => {
    writeFileSync(savedPath(), `${JSON.stringify({ revision: 999 })}\n${JSON.stringify(["/t/a.jsonl", { project: { path: "/w", final: true, mtimeMs: 1, size: 1 } }])}`)
    await startFactPersistence()
    expect(factsFor("/t/a.jsonl")).toBeUndefined()

    resetFacts()
    writeFileSync(savedPath(), "{ not json")
    await startFactPersistence()
    expect(factsFor("/t/a.jsonl")).toBeUndefined()
  })

  it("does not write anything before persistence starts", async () => {
    recordFact("/t/a.jsonl", "project", { path: "/w", final: true, mtimeMs: 1, size: 1 })
    expect(() => readFileSync(savedPath())).toThrow()
  })
})

describe("pruning", () => {
  it("forgets files a full listing of their root no longer finds, and nothing outside that root", () => {
    for (const filePath of ["/root/a.jsonl", "/root/b.jsonl", "/rooted/c.jsonl"]) {
      recordFact(filePath, "project", { path: "/w", final: true, mtimeMs: 1, size: 1 })
    }
    pruneFactsUnder("/root", new Set(["/root/a.jsonl"]))
    expect(factsFor("/root/a.jsonl")).toBeDefined()
    expect(factsFor("/root/b.jsonl")).toBeUndefined()
    expect(factsFor("/rooted/c.jsonl")).toBeDefined()
  })
})

describe("fact validity", () => {
  const fact = { mtimeMs: 10, size: 100 }

  it("uses a stamped fact only at exactly its size and mtime", () => {
    expect(isCurrent(fact, { mtimeMs: 10, size: 100 })).toBe(true)
    expect(isCurrent(fact, { mtimeMs: 11, size: 100 })).toBe(false)
    expect(isCurrent(fact, { mtimeMs: 10, size: 101 })).toBe(false)
  })

  it("keeps a final fact while the file grows, and drops it when the file shrinks or goes back in time", () => {
    expect(isStillTrue({ ...fact, final: true }, { mtimeMs: 20, size: 500 })).toBe(true)
    expect(isStillTrue({ ...fact, final: true }, { mtimeMs: 20, size: 50 })).toBe(false)
    expect(isStillTrue({ ...fact, final: true }, { mtimeMs: 5, size: 500 })).toBe(false)
    expect(isStillTrue({ ...fact, final: false }, { mtimeMs: 20, size: 500 })).toBe(false)
  })
})
