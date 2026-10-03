// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

import type { Middleware } from "../http"
import { collectRoutes, createMockReqRes, getRouteHandler } from "./http-fixtures"

describe("collectRoutes", () => {
  it("keeps every middleware mounted at one path, run in mount order as the server runs them", () => {
    const ran: string[] = []
    const pass = (name: string): Middleware => (_req, _res, next) => {
      ran.push(name)
      next()
    }
    const handlers = collectRoutes((use) => {
      use("/api", pass("compression"))
      use("/api/hello", pass("hello"))
      use("/api", pass("monitor"))
    })
    const { req, res, next } = createMockReqRes("GET", "/api/anything")

    getRouteHandler(handlers, "/api")(req, res, next)

    expect([...handlers.keys()]).toEqual(["/api", "/api/hello"])
    expect(ran).toEqual(["compression", "monitor"])
    expect(next).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it("stops at a middleware that answers, and hands an error straight on", () => {
    const later = vi.fn()
    const failure = new Error("boom")
    const answering = collectRoutes((use) => {
      use("/api", (_req, res) => { res.end("answered") })
      use("/api", later)
    })
    const failing = collectRoutes((use) => {
      use("/api", (_req, _res, next) => next(failure))
      use("/api", later)
    })
    const answered = createMockReqRes("GET", "/api")
    const failed = createMockReqRes("GET", "/api")

    getRouteHandler(answering, "/api")(answered.req, answered.res, answered.next)
    getRouteHandler(failing, "/api")(failed.req, failed.res, failed.next)

    expect(answered.res._getData()).toBe("answered")
    expect(answered.next).not.toHaveBeenCalled()
    expect(failed.next).toHaveBeenCalledExactlyOnceWith(failure)
    expect(later).not.toHaveBeenCalled()
  })
})
