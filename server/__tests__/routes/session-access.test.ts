// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_ACCESS_HEADER } from "../../../shared/contracts/sessionAccess"
import { __resetEditionForTest, PERSONAL_EDITION, sendSessionHidden, type EditionSessionAccess } from "../../edition"
import { registerSessionAccessRoutes } from "../../routes/session-access"
import { installFakeEdition } from "../edition/fakeEdition"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

const SESSION = "11111111-1111-4111-8111-111111111111"

async function lookUp(url: string, method = "GET") {
  const handler = getRouteHandler(collectRoutes(registerSessionAccessRoutes), "/api/session-access/")
  const { req, res, next } = createMockReqRes(method, url)
  await handler(req, res, next)
  return {
    status: res._getStatus(),
    body: JSON.parse(res._getData() || "null") as unknown,
    headers: res._getHeaders(),
    next,
  }
}

/** An edition whose checks answer from `levels`, by the id each session is authorized under. */
function installLevels(levels: Record<string, "view" | "interact" | "own" | null>): EditionSessionAccess["levelOf"] {
  const levelOf = vi.fn<EditionSessionAccess["levelOf"]>(async (_req, sessionId) => levels[sessionId] ?? null)
  installFakeEdition({
    access: {
      ...PERSONAL_EDITION.access,
      authorizeSession: async (_req, res, ref) => {
        const sessionId = "sessionId" in ref ? ref.sessionId.toLowerCase() : ref.fileName
        if (levels[sessionId] === undefined) return sendSessionHidden(res, sessionId)
        return { sessionId, filePath: null, isRootTranscript: true }
      },
      levelOf,
    },
  })
  return levelOf
}

afterEach(() => __resetEditionForTest())

describe("GET /api/session-access/:sessionId", () => {
  it("answers every session as the caller's own in personal edition", async () => {
    const { status, body } = await lookUp(`/${SESSION}`)

    expect(status).toBe(200)
    expect(body).toEqual({ sessionId: SESSION, level: "own" })
  })

  it("answers the level the edition gives, for the session it authorized", async () => {
    const levelOf = installLevels({ [SESSION]: "view" })

    const { status, body } = await lookUp(`/${SESSION.toUpperCase()}`)

    expect(status).toBe(200)
    expect(body).toEqual({ sessionId: SESSION, level: "view" })
    expect(levelOf).toHaveBeenCalledWith(expect.anything(), SESSION)
  })

  it("answers a session the caller cannot see as hidden, with the access header", async () => {
    installLevels({})

    const { status, headers } = await lookUp(`/${SESSION}`)

    expect(status).toBe(404)
    expect(headers[SESSION_ACCESS_HEADER]).toBe("none")
  })

  it("answers as hidden when the level is gone by the time it is read", async () => {
    installLevels({ [SESSION]: null })

    const { status, headers } = await lookUp(`/${SESSION}`)

    expect(status).toBe(404)
    expect(headers[SESSION_ACCESS_HEADER]).toBe("none")
  })

  it("leaves other methods and deeper paths to later routes", async () => {
    expect((await lookUp(`/${SESSION}`, "PUT")).next).toHaveBeenCalled()
    expect((await lookUp(`/${SESSION}/grants/u_bob`)).next).toHaveBeenCalled()
    expect((await lookUp("/%E0%A4%A")).next).toHaveBeenCalled()
  })
})
