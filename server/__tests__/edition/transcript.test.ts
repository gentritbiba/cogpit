// @vitest-environment node
import type { IncomingMessage } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dirs } from "../../dirs"
import {
  __resetEditionForTest,
  installEdition,
  PERSONAL_EDITION,
  type AuthorizedSession,
  type VisibilityCheck,
  type VisibleSession,
} from "../../edition"
import { authorizeTranscript, visibleChildTranscripts, visibleTranscript } from "../../edition/transcript"
import { createMiddlewareRes } from "../http-fixtures"

const req = { method: "GET", url: "/api/x", headers: {} } as IncomingMessage
const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
const PROJECT = "-Users-me-proj"

let root: string
let previousProjectsDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-authorized-transcript-"))
  previousProjectsDir = dirs.PROJECTS_DIR
  dirs.PROJECTS_DIR = root
  await mkdir(join(root, PROJECT), { recursive: true })
  await writeFile(join(root, PROJECT, `${SESSION}.jsonl`), "{}\n")
})

afterEach(async () => {
  dirs.PROJECTS_DIR = previousProjectsDir
  __resetEditionForTest()
  await rm(root, { recursive: true, force: true })
})

/** An edition whose access check answers `decision` for every ref. */
function useEditionDeciding(decision: AuthorizedSession | null) {
  const authorizeSession = vi.fn(async () => decision)
  __resetEditionForTest()
  installEdition({ ...PERSONAL_EDITION, edition: "team", access: { ...PERSONAL_EDITION.access, authorizeSession } })
  return authorizeSession
}

describe("authorizeTranscript", () => {
  it("serves the transcript the owning store resolves when the check names no file", async () => {
    const mock = createMiddlewareRes()
    await expect(authorizeTranscript(req, mock.res, { dirName: PROJECT, fileName: `${SESSION}.jsonl` }, "view"))
      .resolves.toEqual({
        sessionId: SESSION,
        filePath: join(root, PROJECT, `${SESSION}.jsonl`),
        isRootTranscript: true,
        transcriptSessionId: SESSION,
      })
    expect(mock.body).toBe("")
  })

  it("leaves an address the store will not serve to its handler", async () => {
    const mock = createMiddlewareRes()
    await expect(authorizeTranscript(req, mock.res, { dirName: PROJECT, fileName: `../${SESSION}.jsonl` }, "view"))
      .resolves.toMatchObject({ filePath: null })
    expect(mock.body).toBe("")
  })

  it("serves exactly the file the access check resolved", async () => {
    const checked = { sessionId: SESSION, filePath: "/checked/transcript.jsonl", isRootTranscript: true }
    const authorizeSession = useEditionDeciding(checked)
    const address = { dirName: PROJECT, fileName: `${SESSION.toUpperCase()}.jsonl` }
    const mock = createMiddlewareRes()

    await expect(authorizeTranscript(req, mock.res, address, "interact"))
      .resolves.toEqual({ ...checked, transcriptSessionId: SESSION.toUpperCase() })
    expect(authorizeSession).toHaveBeenCalledWith(req, mock.res, address, "interact")
  })

  it("stops at a refused check, which has already answered", async () => {
    useEditionDeciding(null)
    const mock = createMiddlewareRes()
    await expect(authorizeTranscript(req, mock.res, { dirName: PROJECT, fileName: `${SESSION}.jsonl` }, "view"))
      .resolves.toBeNull()
    expect(mock.body).toBe("")
  })
})

describe("an authorized transcript's own session", () => {
  async function ownSessionId(fileName: string): Promise<string | null | undefined> {
    const address = { dirName: PROJECT, fileName }
    return (await authorizeTranscript(req, createMiddlewareRes().res, address, "view"))?.transcriptSessionId
  }

  it("names the session of its own transcript, as the address spells it", async () => {
    await expect(ownSessionId(`${SESSION}.jsonl`)).resolves.toBe(SESSION)
    useEditionDeciding({ sessionId: SESSION, filePath: join(root, PROJECT, `${SESSION}.jsonl`), isRootTranscript: true })
    await expect(ownSessionId(`${SESSION.toUpperCase()}.jsonl`)).resolves.toBe(SESSION.toUpperCase())
  })

  it("takes the check's word for whose transcript it allowed, reading nothing", async () => {
    useEditionDeciding({ sessionId: SESSION, filePath: "/checked/elsewhere.jsonl", isRootTranscript: true })
    await expect(ownSessionId(`${SESSION}.jsonl`)).resolves.toBe(SESSION)
    useEditionDeciding({ sessionId: SESSION, filePath: join(root, PROJECT, `${SESSION}.jsonl`), isRootTranscript: false })
    await expect(ownSessionId(`${SESSION}.jsonl`)).resolves.toBeNull()
  })

  it("names no session for a transcript filed under the session, whatever its name spells", async () => {
    for (const fileName of [
      `${SESSION}/workflows/${OTHER}.jsonl`,
      `${SESSION}/workflows/${SESSION}.jsonl`,
      `${SESSION}/subagents/agent-a1b2.jsonl`,
    ]) {
      await mkdir(dirname(join(root, PROJECT, fileName)), { recursive: true })
      await writeFile(join(root, PROJECT, fileName), "{}\n")
      await expect(ownSessionId(fileName), fileName).resolves.toBeNull()
    }
  })

  it("names no session for a file the check placed under the session checked", async () => {
    for (const fileName of [`${SESSION}/workflows/${OTHER}.jsonl`, `${SESSION}/subagents/agent-a1b2.jsonl`]) {
      useEditionDeciding({ sessionId: SESSION, filePath: join(root, PROJECT, fileName), isRootTranscript: false })
      await expect(ownSessionId(fileName), fileName).resolves.toBeNull()
    }
  })

  it("names no session for a transcript the store does not serve, or another session's", async () => {
    await expect(ownSessionId(`../${SESSION}.jsonl`)).resolves.toBeNull()
    useEditionDeciding({ sessionId: OTHER, filePath: join(root, PROJECT, `${SESSION}.jsonl`), isRootTranscript: true })
    await expect(ownSessionId(`${SESSION}.jsonl`)).resolves.toBeNull()
  })
})

const SHOWN: VisibleSession = { annotate: async (item) => item }

/** A list check that hides every session in `hidden`, remembering what it was asked. */
function checkHiding(...hidden: string[]) {
  return Object.assign(
    vi.fn(async (sessionId: string) => hidden.includes(sessionId) ? "hidden" as const : SHOWN),
    { everything: false, nothing: false },
  ) satisfies VisibilityCheck
}

describe("visibleTranscript", () => {
  const AGENT_FILE = `${SESSION}/subagents/agent-a1.jsonl`

  beforeEach(async () => {
    await mkdir(join(root, PROJECT, SESSION, "subagents"), { recursive: true })
    await writeFile(join(root, PROJECT, AGENT_FILE), "{}\n")
  })

  it("is the file an address reaches, checked as the session it is filed under", async () => {
    const check = checkHiding()
    await expect(visibleTranscript(check, { dirName: PROJECT, fileName: AGENT_FILE }))
      .resolves.toMatchObject({ sessionId: SESSION, filePath: join(root, PROJECT, AGENT_FILE) })
    expect(check).toHaveBeenCalledWith(SESSION, undefined)
  })

  it("is null when the session it is filed under is hidden", async () => {
    await expect(visibleTranscript(checkHiding(SESSION), { dirName: PROJECT, fileName: AGENT_FILE })).resolves.toBeNull()
  })

  it("is null for an address the store does not serve, checking nothing", async () => {
    const check = checkHiding()
    await expect(visibleTranscript(check, { dirName: PROJECT, fileName: `../${SESSION}.jsonl` })).resolves.toBeNull()
    expect(check).not.toHaveBeenCalled()
  })
})

describe("visibleChildTranscripts", () => {
  const child = (agentId: string, fileName?: string) => ({ agentId, size: 1, modifiedAt: 1, ...(fileName && { fileName }) })

  /** An edition whose list check hides every session in `hidden`. */
  function useCheckHiding(...hidden: string[]) {
    const check = checkHiding(...hidden)
    installEdition({ ...PERSONAL_EDITION, edition: "team", access: { ...PERSONAL_EDITION.access, visibilityFor: () => check } })
    return check
  }

  it("keeps every child in personal edition, reading nothing", async () => {
    const children = [child("a1"), child(OTHER, `../elsewhere/${OTHER}.jsonl`)]
    await expect(visibleChildTranscripts(req, PROJECT)(children)).resolves.toEqual(children)
  })

  it("keeps a child filed under the session without checking it", async () => {
    const check = useCheckHiding(SESSION)
    const children = [child("a1")]
    await expect(visibleChildTranscripts(req, PROJECT)(children)).resolves.toEqual(children)
    expect(check).not.toHaveBeenCalled()
  })

  it("checks a child kept apart as the session its file really is, by its own transcript", async () => {
    await writeFile(join(root, PROJECT, `${OTHER}.jsonl`), "{}\n")
    const kept = child(OTHER, `${OTHER}.jsonl`)
    const check = useCheckHiding()
    await expect(visibleChildTranscripts(req, PROJECT)([kept])).resolves.toEqual([kept])
    expect(check).toHaveBeenCalledWith(OTHER, expect.objectContaining({
      sessionId: OTHER,
      parentSessionId: null,
      filePath: join(root, PROJECT, `${OTHER}.jsonl`),
    }))

    __resetEditionForTest()
    useCheckHiding(OTHER)
    await expect(visibleChildTranscripts(req, PROJECT)([kept])).resolves.toEqual([])
  })

  it("drops a child kept apart whose file the store does not serve", async () => {
    useCheckHiding()
    await expect(visibleChildTranscripts(req, PROJECT)([child(OTHER, `../${OTHER}.jsonl`)])).resolves.toEqual([])
  })
})
