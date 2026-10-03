// @vitest-environment node
import { describe, expect, it } from "vitest"
import { extractImports } from "../../../scripts/lib/importReferences"

/** check:architecture keeps core off the team edition by the specifiers this finds, test files included. */
function specifiers(source: string): string[] {
  return extractImports(source, "probe.test.ts").map((reference) => reference.specifier)
}

describe("extractImports", () => {
  it("finds imports, re-exports, import() and require()", () => {
    expect(specifiers([
      `import a from "static"`,
      `import type { B } from "type-only"`,
      `export { c } from "re-export"`,
      `export * from "star"`,
      `const d = await import("dynamic")`,
      `const e = require("required")`,
      `import f = require("import-equals")`,
    ].join("\n"))).toEqual(["static", "type-only", "re-export", "star", "dynamic", "required", "import-equals"])
  })

  it("finds import() with options and the calls that resolve a module without loading it", () => {
    expect(specifiers([
      `const manifest = await import("with-options", { with: { type: "json" } })`,
      `const path = require.resolve("require-resolved")`,
      `const withPaths = require.resolve("require-resolved-in", { paths: [dir] })`,
      `const url = import.meta.resolve("meta-resolved")`,
    ].join("\n"))).toEqual(["with-options", "require-resolved", "require-resolved-in", "meta-resolved"])
  })

  it("finds a module named only in a type", () => {
    expect(specifiers([
      `type Team = typeof import("type-query")`,
      `let value: import("type-reference").Thing`,
      `const actual = await importOriginal<typeof import("type-argument")>()`,
    ].join("\n"))).toEqual(["type-query", "type-reference", "type-argument"])
  })

  it("finds the modules a test mocks or loads around its mocks", () => {
    expect(specifiers([
      `vi.mock("mocked", () => ({}))`,
      `vi.doMock("do-mocked")`,
      `vi.unmock("unmocked")`,
      `vi.doUnmock("do-unmocked")`,
      `const actual = await vi.importActual("actual")`,
      `const mock = await vi.importMock("mock")`,
    ].join("\n"))).toEqual(["mocked", "do-mocked", "unmocked", "do-unmocked", "actual", "mock"])
  })

  it("finds triple-slash path and type references, a bare path as relative", () => {
    expect(specifiers([
      `/// <reference path="../../editions/team/index.ts" />`,
      `/// <reference path="sibling.d.ts" />`,
      `/// <reference types="@cogpit/team" />`,
      `/// <reference lib="es2022" />`,
      `import a from "static"`,
    ].join("\n"))).toEqual(["../../editions/team/index.ts", "./sibling.d.ts", "@cogpit/team", "static"])
  })

  it("ignores computed specifiers and calls that load no module", () => {
    expect(specifiers([
      `const name = "hidden"`,
      `await import(name)`,
      `vi.mock(name)`,
      `vi.fn("not-a-module")`,
      `other.mock("not-a-module")`,
      `promise.resolve("not-a-module")`,
      `import.meta.url.resolve("not-a-module")`,
      `require("a", "b")`,
    ].join("\n"))).toEqual([])
  })

  it("reports the line each reference is on", () => {
    expect(extractImports(`/// <reference types="w" />\n\ntype T = typeof import("x")\nvi.mock("y")`, "probe.ts"))
      .toEqual([{ specifier: "w", line: 1 }, { specifier: "x", line: 3 }, { specifier: "y", line: 4 }])
  })
})
