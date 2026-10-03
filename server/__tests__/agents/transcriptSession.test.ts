// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveTranscriptSession } from "../../agents/transcriptSession"
import { dirs } from "../../dirs"

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
const PROJECT = "-Users-me-proj"

let root: string
let previousProjectsDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-transcript-session-"))
  previousProjectsDir = dirs.PROJECTS_DIR
  dirs.PROJECTS_DIR = root
  await mkdir(join(root, PROJECT, SESSION, "subagents"), { recursive: true })
  await Promise.all([
    writeFile(join(root, PROJECT, `${SESSION}.jsonl`), "{}\n"),
    writeFile(join(root, PROJECT, `${OTHER}.jsonl`), "{}\n"),
    writeFile(join(root, PROJECT, SESSION, "subagents", "agent-a1.jsonl"), "{}\n"),
  ])
})

afterEach(async () => {
  dirs.PROJECTS_DIR = previousProjectsDir
  await rm(root, { recursive: true, force: true })
})

describe("resolveTranscriptSession", () => {
  it("names the session of its own transcript, with lineage read from that transcript", async () => {
    const filePath = join(root, PROJECT, `${SESSION}.jsonl`)
    await expect(resolveTranscriptSession(PROJECT, `${SESSION}.jsonl`)).resolves.toEqual({
      sessionId: SESSION,
      filePath,
      isRootTranscript: true,
      hint: expect.objectContaining({ sessionId: SESSION, parentSessionId: null, filePath }),
    })
  })

  it("names the session a sub-agent transcript is filed under, with no lineage to read", async () => {
    await expect(resolveTranscriptSession(PROJECT, `${SESSION}/subagents/agent-a1.jsonl`)).resolves.toEqual({
      sessionId: SESSION,
      filePath: join(root, PROJECT, SESSION, "subagents", "agent-a1.jsonl"),
      isRootTranscript: false,
      hint: undefined,
    })
  })

  it("names the session of the file an address really reaches, whatever it spells", async () => {
    await expect(resolveTranscriptSession(PROJECT, `${SESSION}/subagents/../../${OTHER}.jsonl`))
      .resolves.toMatchObject({ sessionId: OTHER, filePath: join(root, PROJECT, `${OTHER}.jsonl`) })
  })

  it("names no session for an address the store does not serve", async () => {
    await expect(resolveTranscriptSession(PROJECT, `../${SESSION}.jsonl`)).resolves.toBeNull()
    await expect(resolveTranscriptSession(PROJECT, "missing.jsonl")).resolves.toBeNull()
  })
})
