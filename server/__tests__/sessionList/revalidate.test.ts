// @vitest-environment node
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setRequestPrincipal } from "../../requestPrincipal"
import { catalogVersion, markCatalogChanged } from "../../sessionCatalog"
import { LIST_EPOCH, __resetListBuildsForTest, sendListResponse, sharedListBuild, type ListBody } from "../../sessionList/revalidate"
import { asIncomingMessage, asServerResponse, createMockReqRes } from "../http-fixtures"

const list = (body: string, archived = "0"): ListBody & { version: number } => ({
  headers: { "X-Cogpit-Archived-Count": archived },
  body,
  version: 3,
})

function answer(response: ListBody & { version: number }, ifNoneMatch?: string) {
  const { req, res } = createMockReqRes("GET", "/", ifNoneMatch ? { headers: { "if-none-match": ifNoneMatch } } : {})
  sendListResponse(req, res, response)
  return res
}

describe("sendListResponse", () => {
  it("sends the body with a weak ETag, the list version and the body's headers", () => {
    const res = answer(list("[1]", "4"))
    expect(res._getStatus()).toBe(200)
    expect(res._getData()).toBe("[1]")
    expect(res._getHeaders()).toMatchObject({
      ETag: expect.stringMatching(/^W\/".+"$/),
      "X-Cogpit-List-Version": "3",
      "X-Cogpit-List-Epoch": LIST_EPOCH,
      "X-Cogpit-Archived-Count": "4",
      "Content-Type": "application/json",
    })
  })

  it("answers 304 without a body to a caller who holds the same answer, at any version", () => {
    const etag = answer(list("[1]"))._getHeaders().ETag!
    const res = answer({ ...list("[1]"), version: 9 }, etag)
    expect(res._getStatus()).toBe(304)
    expect(res._getData()).toBe("")
    expect(res._getHeaders()).toMatchObject({ ETag: etag, "X-Cogpit-List-Version": "9" })
    expect(answer(list("[1]"), `"other", ${etag.slice(2)}`)._getStatus()).toBe(304)
  })

  it("changes the ETag when the body or a header the caller keeps on 304 changes", () => {
    const etag = answer(list("[1]"))._getHeaders().ETag!
    expect(answer(list("[2]"), etag)._getStatus()).toBe(200)
    expect(answer(list("[1]", "1"), etag)._getStatus()).toBe(200)
  })
})

function request(principal?: { userId: string; role: string }) {
  const req = asIncomingMessage({ method: "GET", url: "/", headers: {} })
  if (principal) setRequestPrincipal(req, { ...principal, username: principal.userId })
  const res = Object.assign(new EventEmitter(), { writableEnded: false })
  return { req, res: asServerResponse(res) }
}

function deferred() {
  let resolve!: (body: ListBody) => void
  const promise = new Promise<ListBody>((done) => { resolve = done })
  return { promise, resolve }
}

describe("sharedListBuild", () => {
  afterEach(() => __resetListBuildsForTest())

  const ask = { route: "test", query: "?a", seesEverything: true }

  it("builds once for callers asking the same of the same version, with the version it started at", async () => {
    const pending = deferred()
    const build = vi.fn(() => pending.promise)
    const version = catalogVersion()
    const first = request()
    const second = request()
    const answers = Promise.all([
      sharedListBuild(first.req, first.res, ask, build),
      sharedListBuild(second.req, second.res, ask, build),
    ])
    pending.resolve({ headers: {}, body: "[]" })
    expect(await answers).toEqual([
      { headers: {}, body: "[]", version },
      { headers: {}, body: "[]", version },
    ])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("builds again for another version, query or principal, and once the last build settled", async () => {
    const build = vi.fn(async () => ({ headers: {}, body: "[]" }))
    const one = request({ userId: "a", role: "member" })
    const other = request({ userId: "b", role: "member" })
    await Promise.all([
      sharedListBuild(one.req, one.res, ask, build),
      sharedListBuild(other.req, other.res, ask, build),
      sharedListBuild(one.req, one.res, { ...ask, query: "?b" }, build),
    ])
    expect(build).toHaveBeenCalledTimes(3)
    await sharedListBuild(one.req, one.res, ask, build)
    markCatalogChanged("touch")
    await sharedListBuild(one.req, one.res, ask, build)
    expect(build).toHaveBeenCalledTimes(5)
  })

  it("never shares between callers without a principal who do not see everything", async () => {
    const build = vi.fn(async () => ({ headers: {}, body: "[]" }))
    const first = request()
    const second = request()
    await Promise.all([
      sharedListBuild(first.req, first.res, { ...ask, seesEverything: false }, build),
      sharedListBuild(second.req, second.res, { ...ask, seesEverything: false }, build),
    ])
    expect(build).toHaveBeenCalledTimes(2)
  })

  it("aborts the build only once every caller waiting on it has gone", async () => {
    const pending = deferred()
    let signal!: AbortSignal
    const build = vi.fn((given: AbortSignal) => {
      signal = given
      return pending.promise
    })
    const first = request()
    const second = request()
    const firstAnswer = sharedListBuild(first.req, first.res, ask, build)
    const secondAnswer = sharedListBuild(second.req, second.res, ask, build)

    first.res.emit("close")
    expect(signal.aborted).toBe(false)
    pending.resolve({ headers: {}, body: "[]" })
    expect(await firstAnswer).toBeNull()
    expect(await secondAnswer).toMatchObject({ body: "[]" })

    const stuck = deferred()
    const next = request()
    const nextAnswer = sharedListBuild(next.req, next.res, { ...ask, query: "?gone" }, (given) => {
      signal = given
      return stuck.promise
    })
    next.res.emit("close")
    expect(signal.aborted).toBe(true)
    stuck.resolve({ headers: {}, body: "[]" })
    expect(await nextAnswer).toBeNull()
  })
})
