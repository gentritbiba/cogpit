// @vitest-environment node
import { describe, expect, it } from "vitest"
import { sendJsonWithEtag } from "../../lib/jsonEtag"
import { createMockReqRes } from "../http-fixtures"

function send(body: unknown, ifNoneMatch?: string) {
  const { req, res } = createMockReqRes("GET", "/", { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} })
  sendJsonWithEtag(req, res, body)
  return { status: res._getStatus(), data: res._getData(), headers: res._getHeaders() }
}

describe("sendJsonWithEtag", () => {
  it("answers JSON with a weak ETag that changes with the body", () => {
    const first = send({ a: 1 })
    expect(first).toMatchObject({ status: 200, data: '{"a":1}', headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } })
    expect(first.headers.ETag).toMatch(/^W\/"[\w-]+"$/)
    expect(send({ a: 1 }).headers.ETag).toBe(first.headers.ETag)
    expect(send({ a: 2 }).headers.ETag).not.toBe(first.headers.ETag)
  })

  it("answers a bodiless 304 when the client names the current tag, however it lists it", () => {
    const etag = send({ a: 1 }).headers.ETag!
    for (const header of [etag, etag.slice(2), `W/"old", ${etag}`, "*"]) {
      expect(send({ a: 1 }, header)).toMatchObject({ status: 304, data: "", headers: { ETag: etag } })
    }
    expect(send({ a: 2 }, etag)).toMatchObject({ status: 200, data: '{"a":2}' })
  })
})
