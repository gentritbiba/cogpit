// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ allSessionBoards: vi.fn(), sessionParents: vi.fn() }))

vi.mock("../../lib/sessionBoards", () => ({ allSessionBoards: mocks.allSessionBoards }))
vi.mock("../../lib/sessionOrigins", () => ({ sessionParents: mocks.sessionParents }))

import { registerSessionBoardRoutes } from "../../routes/session-boards"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function call(method: string, url: string) {
  const handler = getRouteHandler(collectRoutes(registerSessionBoardRoutes), "/api/session-boards")
  const { req, res, next } = createMockReqRes(method, url)
  await handler(req, res, next)
  return { body: JSON.parse(res._getData() || "null"), next }
}

beforeEach(() => {
  mocks.allSessionBoards.mockResolvedValue([
    { sessionId: "worker", title: "Nav fix", sections: [], updatedAt: 3 },
    { sessionId: "pm", title: "Release 52", progress: { done: 3, total: 4 }, sections: [], updatedAt: 2 },
  ])
  mocks.sessionParents.mockResolvedValue(new Map([
    ["lead", { parentSessionId: "pm", createdAt: 1 }],
    ["worker", { parentSessionId: "lead", createdAt: 2, name: "STOREFRONT · GL-180" }],
  ]))
})

describe("GET /api/session-boards", () => {
  it("lists every board in the order the store keeps, each placed in its crew", async () => {
    expect((await call("GET", "/")).body).toEqual({
      boards: [
        { sessionId: "worker", title: "Nav fix", sections: [], updatedAt: 3, rootId: "pm", parentSessionId: "lead", name: "STOREFRONT · GL-180" },
        { sessionId: "pm", title: "Release 52", progress: { done: 3, total: 4 }, sections: [], updatedAt: 2, rootId: "pm" },
      ],
    })
  })

  it("leaves other methods and paths to the next route", async () => {
    expect((await call("POST", "/")).next).toHaveBeenCalled()
    expect((await call("GET", "/worker")).next).toHaveBeenCalled()
  })
})
