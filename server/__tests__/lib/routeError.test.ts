// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import type { ServerResponse } from "node:http"
import { RouteError, ErrorCodes, sendError } from "../../lib/routeError"
import type { RouteErrorShape } from "../../lib/routeError"

// ── RouteError constructor ──────────────────────────────────────────────

describe("RouteError constructor", () => {
  it("preserves status, code, and message", () => {
    const err = new RouteError(404, ErrorCodes.NOT_FOUND, "Resource not found")
    expect(err.status).toBe(404)
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toBe("Resource not found")
    expect(err.name).toBe("RouteError")
  })

  it("preserves details when provided", () => {
    const details = { field: "email", reason: "invalid format" }
    const err = new RouteError(400, ErrorCodes.INVALID_REQUEST, "Validation failed", details)
    expect(err.details).toEqual(details)
  })

  it("details is undefined when not provided", () => {
    const err = new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Something went wrong")
    expect(err.details).toBeUndefined()
  })

  it("is an instance of Error", () => {
    const err = new RouteError(400, ErrorCodes.INVALID_REQUEST, "Bad request")
    expect(err).toBeInstanceOf(Error)
  })
})

// ── RouteError.toResponse ───────────────────────────────────────────────

describe("RouteError.toResponse()", () => {
  it("returns correct shape without details", () => {
    const err = new RouteError(404, ErrorCodes.NOT_FOUND, "Not found")
    const response = err.toResponse()
    expect(response).toEqual({ error: "Not found", code: "NOT_FOUND" })
    expect("details" in response).toBe(false)
  })

  it("returns correct shape with details", () => {
    const details = [{ field: "name", message: "required" }]
    const err = new RouteError(400, ErrorCodes.INVALID_REQUEST, "Validation failed", details)
    const response = err.toResponse()
    expect(response).toEqual({
      error: "Validation failed",
      code: "INVALID_REQUEST",
      details,
    })
  })

  it("omits details key entirely when undefined (no details: undefined in JSON)", () => {
    const err = new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Oops")
    const json = JSON.stringify(err.toResponse())
    expect(json).not.toContain("details")
  })
})

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMockRes() {
  let statusCode = 200
  let body = ""
  const headers: Record<string, string> = {}
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    end: vi.fn((data?: string) => {
      body = data ?? ""
    }),
    _getStatus: () => statusCode,
    _getBody: () => body,
    _getHeaders: () => headers,
  } as unknown as ServerResponse & {
    _getStatus: () => number
    _getBody: () => string
    _getHeaders: () => Record<string, string>
  }
  return res
}

// ── sendError with RouteError ───────────────────────────────────────────

describe("sendError with RouteError", () => {
  it("writes the RouteError status code", () => {
    const res = makeMockRes()
    const err = new RouteError(404, ErrorCodes.NOT_FOUND, "Not found")
    sendError(res, err)
    expect(res._getStatus()).toBe(404)
  })

  it("sets Content-Type: application/json", () => {
    const res = makeMockRes()
    sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Bad"))
    expect(res._getHeaders()["Content-Type"]).toBe("application/json")
  })

  it("writes correct JSON body", () => {
    const res = makeMockRes()
    const err = new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied")
    sendError(res, err)
    expect(JSON.parse(res._getBody())).toEqual({ error: "Access denied", code: "FORBIDDEN" })
  })

  it("includes details in body when present", () => {
    const res = makeMockRes()
    const details = { hint: "use a different value" }
    const err = new RouteError(409, ErrorCodes.CONFLICT, "Already exists", details)
    sendError(res, err)
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Already exists",
      code: "CONFLICT",
      details,
    })
  })

  it("ignores defaultStatus parameter — uses RouteError.status", () => {
    const res = makeMockRes()
    const err = new RouteError(422, ErrorCodes.INVALID_REQUEST, "Unprocessable")
    sendError(res, err, 400)
    expect(res._getStatus()).toBe(422)
  })
})

// ── sendError with plain Error ──────────────────────────────────────────

describe("sendError with plain Error", () => {
  it("uses defaultStatus (500) when not provided", () => {
    const res = makeMockRes()
    sendError(res, new Error("Something broke"))
    expect(res._getStatus()).toBe(500)
  })

  it("uses provided defaultStatus", () => {
    const res = makeMockRes()
    sendError(res, new Error("Bad input"), 400)
    expect(res._getStatus()).toBe(400)
  })

  it("sets code to INTERNAL_ERROR", () => {
    const res = makeMockRes()
    sendError(res, new Error("Unexpected failure"))
    const body = JSON.parse(res._getBody())
    expect(body.code).toBe("INTERNAL_ERROR")
  })

  it("uses the error message", () => {
    const res = makeMockRes()
    sendError(res, new Error("Detailed message"))
    const body = JSON.parse(res._getBody())
    expect(body.error).toBe("Detailed message")
  })

  it("sets Content-Type: application/json", () => {
    const res = makeMockRes()
    sendError(res, new Error("x"))
    expect(res._getHeaders()["Content-Type"]).toBe("application/json")
  })
})

// ── sendError with RouteErrorShape ─────────────────────────────────────

describe("sendError with RouteErrorShape", () => {
  it("uses the defaultStatus (500) when not provided", () => {
    const res = makeMockRes()
    const shape: RouteErrorShape = { error: "Custom error", code: "NOT_CONFIGURED" }
    sendError(res, shape)
    expect(res._getStatus()).toBe(500)
  })

  it("uses the provided defaultStatus", () => {
    const res = makeMockRes()
    const shape: RouteErrorShape = { error: "Not ready", code: "NOT_CONFIGURED" }
    sendError(res, shape, 503)
    expect(res._getStatus()).toBe(503)
  })

  it("writes the shape directly as JSON", () => {
    const res = makeMockRes()
    const shape: RouteErrorShape = { error: "Custom error", code: "NOT_CONFIGURED" }
    sendError(res, shape)
    expect(JSON.parse(res._getBody())).toEqual(shape)
  })

  it("includes details from shape when present", () => {
    const res = makeMockRes()
    const shape: RouteErrorShape = {
      error: "Validation failed",
      code: "INVALID_REQUEST",
      details: { fields: ["email"] },
    }
    sendError(res, shape)
    expect(JSON.parse(res._getBody())).toEqual(shape)
  })

  it("sets Content-Type: application/json", () => {
    const res = makeMockRes()
    sendError(res, { error: "e", code: "INTERNAL_ERROR" })
    expect(res._getHeaders()["Content-Type"]).toBe("application/json")
  })
})
