// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest"

const { stat } = vi.hoisted(() => ({ stat: vi.fn() }))

vi.mock("node:fs/promises", () => ({ stat }))

import {
  resolveFileRequestPath,
  validateReadableFile,
} from "../../routes/readableFileRequest"

afterEach(() => {
  vi.clearAllMocks()
})

describe("resolveFileRequestPath", () => {
  it("requires a path query parameter", async () => {
    expect(resolveFileRequestPath("/api/file-content")).toEqual({
      ok: false,
      statusCode: 400,
      error: "path query parameter required",
    })
    expect(stat).not.toHaveBeenCalled()
  })

  it("rejects relative paths before touching the filesystem", async () => {
    expect(resolveFileRequestPath("/api/file-content?path=relative.txt")).toEqual({
      ok: false,
      statusCode: 400,
      error: "path must be absolute",
    })
    expect(stat).not.toHaveBeenCalled()
  })

  it("decodes and returns an absolute path", () => {
    expect(
      resolveFileRequestPath("/api/file-content?path=%2Ftmp%2Fnotes.txt"),
    ).toEqual({ ok: true, filePath: "/tmp/notes.txt" })
  })
})

describe("validateReadableFile", () => {
  it("accepts a regular file within the endpoint limit", async () => {
    stat.mockResolvedValue({ isFile: () => true, size: 99 })

    await expect(validateReadableFile("/tmp/notes.txt", 100)).resolves.toEqual({ ok: true })
  })

  it("rejects directories and oversized files with stable errors", async () => {
    stat.mockResolvedValueOnce({ isFile: () => false, size: 0 })
    await expect(
      validateReadableFile("/tmp/folder", 100),
    ).resolves.toEqual({ ok: false, statusCode: 404, error: "Not a file" })

    stat.mockResolvedValueOnce({ isFile: () => true, size: 101 })
    await expect(
      validateReadableFile("/tmp/large.txt", 100),
    ).resolves.toEqual({ ok: false, statusCode: 413, error: "File too large" })
  })

  it("maps filesystem failures to the public not-found response", async () => {
    stat.mockRejectedValue(new Error("gone"))

    await expect(
      validateReadableFile("/tmp/gone.txt", 100),
    ).resolves.toEqual({ ok: false, statusCode: 404, error: "File not found" })
  })
})
