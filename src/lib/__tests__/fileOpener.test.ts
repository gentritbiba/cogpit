import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
vi.mock("@/lib/device", () => ({ isRemoteDeviceActive: vi.fn(() => false) }))
vi.mock("@/lib/utils", () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }))

import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import { copyToClipboard } from "@/lib/utils"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import {
  __resetFileOpenerForTest,
  openFile,
  openProject,
  registerBuiltInFileOpener,
  resolveBuiltInEditorTarget,
  revealInFolder,
  setBuiltInEditorEnabled,
  type FileOpenTarget,
} from "@/lib/fileOpener"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"

const mockAuthFetch = vi.mocked(authFetch)
const mockIsRemoteDeviceActive = vi.mocked(isRemoteDeviceActive)

beforeEach(() => {
  vi.clearAllMocks()
  mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }))
  mockIsRemoteDeviceActive.mockReturnValue(false)
})

afterEach(() => {
  __resetFileOpenerForTest()
  __resetCapabilitiesForTest()
})

describe("resolveBuiltInEditorTarget", () => {
  it("keeps the project as the root for files inside it", () => {
    const target: FileOpenTarget = { kind: "file", path: "/repo/src/app.ts", line: 12 }
    expect(resolveBuiltInEditorTarget(target, "/repo")).toEqual({
      root: "/repo",
      file: "src/app.ts",
      mode: "edit",
      line: 12,
    })
  })

  it("carries diff mode through", () => {
    expect(resolveBuiltInEditorTarget(
      { kind: "file", path: "/repo/src/app.ts", mode: "diff" },
      "/repo",
    )).toMatchObject({ root: "/repo", file: "src/app.ts", mode: "diff" })
  })

  it("browses the containing directory for files outside the project", () => {
    expect(resolveBuiltInEditorTarget(
      { kind: "file", path: "/home/me/.claude/skills/commit/SKILL.md" },
      "/repo",
    )).toEqual({
      root: "/home/me/.claude/skills/commit",
      file: "SKILL.md",
      mode: "edit",
      line: undefined,
    })
  })

  it("resolves without an active project", () => {
    expect(resolveBuiltInEditorTarget({ kind: "file", path: "/repo/src/app.ts" }, null))
      .toMatchObject({ root: "/repo/src", file: "app.ts" })
  })

  it("opens a project directory with nothing selected", () => {
    expect(resolveBuiltInEditorTarget({ kind: "project", path: "/repo" }, "/repo"))
      .toEqual({ root: "/repo", file: null, mode: "edit" })
  })

  it("rejects an empty path", () => {
    expect(resolveBuiltInEditorTarget({ kind: "file", path: "" }, "/repo")).toBeNull()
  })
})

describe("openFile", () => {
  it("posts to the host editor when the built-in workspace is off", () => {
    registerBuiltInFileOpener(() => true)

    openFile("/repo/src/app.ts", { line: 4, column: 2 })

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-in-editor", expect.objectContaining({
      body: JSON.stringify({ path: "/repo/src/app.ts", mode: "file", line: 4, column: 2 }),
    }))
  })

  it("hands the request to the built-in workspace when preferred", () => {
    const opener = vi.fn(() => true)
    registerBuiltInFileOpener(opener)
    setBuiltInEditorEnabled(true)

    openFile("/repo/src/app.ts", { mode: "diff" })

    expect(opener).toHaveBeenCalledWith({ kind: "file", path: "/repo/src/app.ts", mode: "diff" })
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("falls back to the host editor when the workspace declines", () => {
    registerBuiltInFileOpener(() => false)
    setBuiltInEditorEnabled(true)

    openFile("/repo/src/app.ts")

    expect(mockAuthFetch).toHaveBeenCalledOnce()
  })

  it("copies the path instead of launching an editor on a remote device", () => {
    mockIsRemoteDeviceActive.mockReturnValue(true)

    openFile("/repo/src/app.ts")

    expect(copyToClipboard).toHaveBeenCalledWith("/repo/src/app.ts")
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("still uses the built-in workspace on a remote device", () => {
    mockIsRemoteDeviceActive.mockReturnValue(true)
    registerBuiltInFileOpener(() => true)
    setBuiltInEditorEnabled(true)

    openFile("/repo/src/app.ts")

    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("does nothing without the hostFiles capability", () => {
    setMe({ authenticated: true, edition: "team", user: null, capabilities: MEMBER_CAPABILITIES })

    openFile("/repo/src/app.ts")

    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("unregisters cleanly", () => {
    const opener = vi.fn(() => true)
    const unregister = registerBuiltInFileOpener(opener)
    setBuiltInEditorEnabled(true)
    unregister()

    openFile("/repo/src/app.ts")

    expect(opener).not.toHaveBeenCalled()
    expect(mockAuthFetch).toHaveBeenCalledOnce()
  })
})

describe("openProject", () => {
  it("sends both path and dirName to the host", () => {
    openProject({ path: "/repo", dirName: "-repo" })

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-in-editor", expect.objectContaining({
      body: JSON.stringify({ path: "/repo", dirName: "-repo" }),
    }))
  })

  it("opens the built-in workspace when a host path is known", () => {
    const opener = vi.fn(() => true)
    registerBuiltInFileOpener(opener)
    setBuiltInEditorEnabled(true)

    openProject({ path: "/repo", dirName: "-repo" })

    expect(opener).toHaveBeenCalledWith({ kind: "project", path: "/repo" })
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("falls back to the host when only a dirName is known", () => {
    registerBuiltInFileOpener(() => true)
    setBuiltInEditorEnabled(true)

    openProject({ dirName: "-repo" })

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-in-editor", expect.objectContaining({
      body: JSON.stringify({ dirName: "-repo" }),
    }))
  })

  it("ignores an empty project reference", () => {
    openProject({ path: null, dirName: null })
    expect(mockAuthFetch).not.toHaveBeenCalled()
  })
})

describe("revealInFolder", () => {
  it("always targets the host file manager", () => {
    registerBuiltInFileOpener(() => true)
    setBuiltInEditorEnabled(true)

    revealInFolder({ path: "/repo", dirName: "-repo" })

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/reveal-in-folder", expect.objectContaining({
      body: JSON.stringify({ path: "/repo", dirName: "-repo" }),
    }))
  })
})
