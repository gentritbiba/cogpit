#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const api = require(join(packageRoot, "dist/index.js"))
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))

assert.equal(manifest.main, "./dist/index.js")
assert.equal(manifest.types, "./dist/index.d.ts")
assert.equal(manifest.engines.node, ">=20")

assert.equal(typeof api.parseSession, "function")
assert.equal(typeof api.SearchIndex, "function")

const databaseFixtureDir = mkdtempSync(join(tmpdir(), "cogpit-memory-contract-"))
const databasePath = join(databaseFixtureDir, "search-index.db")
try {
  const searchIndex = new api.SearchIndex(databasePath)
  try {
    const stats = searchIndex.getStats()
    assert.equal(stats.dbPath, databasePath)
    assert.ok(stats.dbSizeBytes > 0)
    assert.equal(stats.indexedFiles, 0)
    assert.equal(stats.indexedSessions, 0)
    assert.equal(stats.indexedSubagents, 0)
    assert.equal(stats.totalRows, 0)
    assert.equal(stats.watcherRunning, false)
    assert.equal(stats.lastFullBuild, null)
    assert.equal(stats.lastUpdate, null)
  } finally {
    searchIndex.close()
  }
} finally {
  rmSync(databaseFixtureDir, { recursive: true, force: true })
}

const jsonl = [
  JSON.stringify({
    type: "user",
    uuid: "user-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "consumer-contract",
    message: { role: "user", content: "hello" },
  }),
  JSON.stringify({
    type: "assistant",
    uuid: "assistant-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    sessionId: "consumer-contract",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }),
].join("\n")

const parsed = api.parseSession(jsonl)
assert.equal(parsed.sessionId, "consumer-contract")
assert.equal(parsed.turns.length, 1)
assert.equal(parsed.rawMessages.length, 2)

const indexOnly = api.parseSession(jsonl, { skipStats: true })
assert.deepEqual(indexOnly.turns, parsed.turns)
assert.deepEqual(indexOnly.rawMessages, [])
assert.equal(indexOnly.stats.turnCount, 1)
assert.equal(indexOnly.stats.totalCostUSD, 0)

const codexJsonl = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { id: "codex-consumer-contract", cwd: "/tmp/project" },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-01-01T00:00:00.500Z",
    payload: { turn_id: "turn-1", cwd: "/tmp/project", model: "gpt-5.4" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-01-01T00:00:01.000Z",
    payload: { type: "user_message", message: "hello from Codex" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-01-01T00:00:02.000Z",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "hello" }],
    },
  }),
].join("\n")

const parsedCodex = api.parseSession(codexJsonl)
const indexOnlyCodex = api.parseSession(codexJsonl, { skipStats: true })
assert.deepEqual(indexOnlyCodex.turns, parsedCodex.turns)
assert.deepEqual(indexOnlyCodex.rawMessages, [])
assert.equal(indexOnlyCodex.stats.turnCount, 1)
assert.equal(indexOnlyCodex.stats.totalCostUSD, 0)
assert.ok(parsedCodex.rawMessages.length > 0)

const cliPath = join(packageRoot, "dist/cli.js")
const help = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" })
assert.equal(help.status, 0, help.stderr)
assert.match(help.stdout, /cogpit-memory - query Claude Code session history/)
assert.equal(help.stderr, "")

const invalid = spawnSync(process.execPath, [cliPath, "not-a-command"], { encoding: "utf8" })
assert.equal(invalid.status, 1)
assert.deepEqual(JSON.parse(invalid.stderr.trim()), { error: "Unknown command: not-a-command" })
assert.match(invalid.stdout, /Commands:/)

const pack = spawnSync("npm", ["pack", "--json", "--dry-run"], {
  cwd: packageRoot,
  encoding: "utf8",
})
assert.equal(pack.status, 0, pack.stderr)
const packFiles = JSON.parse(pack.stdout)[0].files.map((file) => file.path)
for (const requiredFile of ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "skill/SKILL.md"]) {
  assert.ok(packFiles.includes(requiredFile), `npm tarball is missing ${requiredFile}`)
}
assert.equal(packFiles.some((file) => file.includes("__tests__")), false)

console.log("Verified cogpit-memory public package and CLI contracts")
