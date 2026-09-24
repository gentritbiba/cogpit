import { describe, expect, it } from "vitest"
import { permissionsForAccess } from "@/lib/sessionAccessPermissions"

describe("permissionsForAccess", () => {
  it.each([
    ["own", true, true],
    ["interact", true, false],
    ["view", false, false],
    ["unknown", false, false],
    ["none", false, false],
  ] as const)("level %s → interact %s, own %s", (level, canInteract, canOwn) => {
    const permissions = permissionsForAccess(level)

    expect(permissions).toEqual({
      canInteract,
      canOwn,
      send: canInteract,
      stop: canInteract,
      answer: canInteract,
      configure: canInteract,
      mcp: canInteract,
      undo: canInteract,
      archive: canOwn,
      delete: canOwn,
    })
  })

  it("returns the same object for a level so context values stay stable", () => {
    expect(permissionsForAccess("view")).toBe(permissionsForAccess("view"))
    expect(permissionsForAccess("unknown")).toBe(permissionsForAccess("view"))
  })
})
