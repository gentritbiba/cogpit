// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getDataRoot, setDataRoot } from "../../config"
import { dirs } from "../../dirs"
import { readSessionUsageCostSummary } from "../../lib/usageCost/service"

const PROJECT = "-work-app"
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

let root: string
let previousProjectsDir: string
let previousDataRoot: string

/** One priced assistant turn of `sessionId`. */
function usageLine(sessionId: string, messageId: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-20T10:00:00.000Z",
    sessionId,
    requestId: `req-${messageId}`,
    message: { id: messageId, model: "claude-opus-4-6", usage: { input_tokens: 100, output_tokens: 50 } },
  }) + "\n"
}

async function write(fileName: string, body: string): Promise<string> {
  const filePath = join(root, "projects", PROJECT, fileName)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
  return filePath
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-session-usage-"))
  previousProjectsDir = dirs.PROJECTS_DIR
  previousDataRoot = getDataRoot()
  dirs.PROJECTS_DIR = join(root, "projects")
  setDataRoot(root)
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline")
  }))
  await write(`${SESSION}.jsonl`, usageLine(SESSION, "msg-main"))
  await write(`${SESSION}/subagents/agent-a1.jsonl`, usageLine(SESSION, "msg-agent"))
  await write(`${OTHER}.jsonl`, usageLine(OTHER, "msg-other"))
  await write(`${OTHER}/subagents/agent-b1.jsonl`, usageLine(OTHER, "msg-other-agent"))
})

afterEach(async () => {
  dirs.PROJECTS_DIR = previousProjectsDir
  setDataRoot(previousDataRoot)
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

const keepEvery = async <T>(children: readonly T[]) => [...children]

describe("readSessionUsageCostSummary", () => {
  it("prices a session's own transcript with its sub-agents'", async () => {
    const summary = await readSessionUsageCostSummary({
      dirName: PROJECT,
      fileName: `${SESSION}.jsonl`,
      filePath: join(root, "projects", PROJECT, `${SESSION}.jsonl`),
      sessionId: SESSION,
      visibleChildren: keepEvery,
    })
    expect(summary).toMatchObject({ sessionId: SESSION, includedFiles: 2, includedSubagents: 1 })
  })

  it("leaves out the sub-agents the caller may not see", async () => {
    const summary = await readSessionUsageCostSummary({
      dirName: PROJECT,
      fileName: `${SESSION}.jsonl`,
      filePath: join(root, "projects", PROJECT, `${SESSION}.jsonl`),
      sessionId: SESSION,
      visibleChildren: async () => [],
    })
    expect(summary).toMatchObject({ sessionId: SESSION, includedFiles: 1, includedSubagents: 0, records: 1 })
  })

  it("prices a transcript filed under a session alone, whatever session its name spells", async () => {
    const planted = await write(`${SESSION}/workflows/${OTHER}.jsonl`, "")
    const summary = await readSessionUsageCostSummary({
      dirName: PROJECT,
      fileName: `${SESSION}/workflows/${OTHER}.jsonl`,
      filePath: planted,
      sessionId: null,
      visibleChildren: keepEvery,
    })
    expect(summary).toMatchObject({ sessionId: "", includedFiles: 1, includedSubagents: 0, records: 0 })
  })

  it("names a sub-agent transcript by the session its records carry", async () => {
    const summary = await readSessionUsageCostSummary({
      dirName: PROJECT,
      fileName: `${SESSION}/subagents/agent-a1.jsonl`,
      filePath: join(root, "projects", PROJECT, SESSION, "subagents", "agent-a1.jsonl"),
      sessionId: null,
      visibleChildren: keepEvery,
    })
    expect(summary).toMatchObject({ sessionId: SESSION, includedFiles: 1, records: 1 })
  })

  it("is null for a transcript that is gone", async () => {
    await expect(readSessionUsageCostSummary({
      dirName: PROJECT,
      fileName: `${SESSION}.jsonl`,
      filePath: join(root, "projects", PROJECT, "missing.jsonl"),
      sessionId: SESSION,
      visibleChildren: keepEvery,
    })).resolves.toBeNull()
  })
})
