// @vitest-environment node
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isTestDirectory, root } from "../../../scripts/lib/sourceFiles"

describe("isTestDirectory", () => {
  it.each(["server/__tests__", "src/components/__tests__", "editions/team/tests"])("counts %s as test code", (path) => {
    expect(isTestDirectory(join(root, path))).toBe(true)
  })

  it.each(["server/tests", "editions/team/server/tests", "editions/team/server"])("keeps %s in the production scan", (path) => {
    expect(isTestDirectory(join(root, path))).toBe(false)
  })
})
