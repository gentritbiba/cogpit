import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), jsonFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, jsonFetch: mocks.jsonFetch }))

import {
  createFolder,
  fetchFolderListing,
  onFolderBrowserRequest,
  openFolderBrowser,
  pathCrumbs,
} from "@/lib/folders"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  mocks.authFetch.mockReset()
  mocks.jsonFetch.mockReset()
})

describe("pathCrumbs", () => {
  it("walks a POSIX path down from the root", () => {
    expect(pathCrumbs("/Users/me/code")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "me", path: "/Users/me" },
      { label: "code", path: "/Users/me/code" },
    ])
    expect(pathCrumbs("/")).toEqual([{ label: "/", path: "/" }])
  })

  it("starts at the top a confined caller may reach", () => {
    expect(pathCrumbs("/Users/me/code", "/Users/me/")).toEqual([
      { label: "me", path: "/Users/me" },
      { label: "code", path: "/Users/me/code" },
    ])
    expect(pathCrumbs("C:\\Users\\me", "C:\\Users")).toEqual([
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ])
    expect(pathCrumbs("/elsewhere", "/Users/me")).toHaveLength(2)
  })

  it("keeps a drive path's spelling", () => {
    expect(pathCrumbs("C:\\Users\\me")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ])
  })

  it("treats a network share as the top", () => {
    expect(pathCrumbs("\\\\nas\\team\\projects")).toEqual([
      { label: "\\\\nas\\team", path: "\\\\nas\\team\\" },
      { label: "projects", path: "\\\\nas\\team\\projects" },
    ])
  })
})

describe("folder API", () => {
  it("lists the projects root without a path and any folder with one", async () => {
    const listing = { path: "/a b", parent: "/", root: "/", folders: [], truncated: false }
    mocks.authFetch.mockImplementation(async () => json(listing))

    await expect(fetchFolderListing(null)).resolves.toEqual(listing)
    await fetchFolderListing("/a b")

    expect(mocks.authFetch.mock.calls.map(([url]) => url)).toEqual(["/api/folders", "/api/folders?path=%2Fa%20b"])
  })

  it("throws the server's own explanation", async () => {
    mocks.authFetch.mockResolvedValue(json({ error: "Cogpit is not allowed to open /root", code: "FORBIDDEN" }, 403))
    await expect(fetchFolderListing("/root")).rejects.toThrow("Cogpit is not allowed to open /root")
  })

  it("names an older server for what it is, not as a missing folder", async () => {
    mocks.authFetch.mockResolvedValue(json({ error: "Not found", code: "NOT_FOUND" }, 404))
    await expect(fetchFolderListing(null)).rejects.toThrow("Browsing folders needs a newer Cogpit on this machine.")
  })

  it("makes a folder and answers its path", async () => {
    mocks.jsonFetch.mockResolvedValue(json({ path: "/home/me/new" }, 201))
    await expect(createFolder("/home/me", "new")).resolves.toBe("/home/me/new")
    expect(mocks.jsonFetch).toHaveBeenCalledWith("/api/folders", { parent: "/home/me", name: "new" })

    mocks.jsonFetch.mockResolvedValue(json({ error: "new already exists in /home/me" }, 409))
    await expect(createFolder("/home/me", "new")).rejects.toThrow("new already exists in /home/me")
  })
})

describe("openFolderBrowser", () => {
  it("reaches every listener until it stops", () => {
    const listener = vi.fn()
    const stop = onFolderBrowserRequest(listener)

    openFolderBrowser()
    stop()
    openFolderBrowser()

    expect(listener).toHaveBeenCalledOnce()
  })
})
