// @vitest-environment node
import { readdirSync } from "node:fs"
import { join, posix } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { editionViolation, repoTarget } from "../../../scripts/lib/editionBoundary"
import { root } from "../../../scripts/lib/sourceFiles"

/** check:architecture's edition rule: whether `source` may name `specifier`. */
function allowed(source: string, specifier: string, isTest = false): boolean {
  return editionViolation(source, { specifier, line: 1 }, isTest) === null
}

describe("editionViolation", () => {
  describe("from core", () => {
    it.each([
      ["the package", "server/app-server.ts", "@cogpit/team"],
      ["a package subpath", "server/app-server.ts", "@cogpit/team/package.json"],
      ["a module inside it", "server/__tests__/edition/probe.test.ts", "../../../editions/team/index"],
      ["its directory", "server/__tests__/edition/probe.test.ts", "../../../editions/team"],
      ["a file that is not a module", "server/__tests__/edition/probe.test.ts", "../../../editions/team/package.json"],
      ["a triple-slash path", "server/__tests__/edition/probe.test.ts", "../../../editions/team/index.ts"],
      ["a path out of the renderer alias", "src/main.tsx", "@/../editions/team/index"],
    ])("refuses %s", (_what, source, specifier) => {
      expect(allowed(source, specifier, source.includes("__tests__"))).toBe(false)
    })

    it("refuses the alias only the edition uses", () => {
      expect(allowed("server/app-server.ts", "@cogpit/core/server/http")).toBe(false)
    })

    it.each([
      ["server/app-server.ts", "./edition"],
      ["server/app-server.ts", "../shared/contracts/identity"],
      ["src/main.tsx", "@/lib/auth"],
      ["server/app-server.ts", "express"],
    ])("allows %s to import %s", (source, specifier) => {
      expect(allowed(source, specifier)).toBe(true)
    })
  })

  describe("from the edition", () => {
    it.each([
      ["editions/team/server/store.ts", "./fileStore"],
      ["editions/team/tests/teamEdition.ts", ".."],
      ["editions/team/server/records/write.ts", "@cogpit/core/server/http"],
      ["editions/team/server/boot.ts", "@cogpit/core/shared/contracts/identity"],
      ["editions/team/server/boot.ts", "node:path"],
    ])("allows %s to import %s", (source, specifier) => {
      expect(allowed(source, specifier)).toBe(true)
    })

    it.each([
      ["core relatively", "editions/team/server/boot.ts", "../../../server/http"],
      ["the renderer through its alias", "editions/team/server/boot.ts", "@/lib/utils"],
      ["core through the renderer alias", "editions/team/server/boot.ts", "@/../server/http"],
      ["a core file that is not a module", "editions/team/server/boot.ts", "../../../package.json"],
      ["core outside server and shared", "editions/team/server/boot.ts", "@cogpit/core/src/lib/auth"],
      ["core outside server through a dot segment", "editions/team/server/boot.ts", "@cogpit/core/server/../src/lib/auth"],
      ["core test code", "editions/team/server/boot.ts", "@cogpit/core/server/__tests__/appServerFixture"],
    ])("refuses %s", (_what, source, specifier) => {
      expect(allowed(source, specifier)).toBe(false)
    })

    it("lets its tests use core's test fixtures", () => {
      expect(allowed("editions/team/tests/app-server.test.ts", "@cogpit/core/server/__tests__/appServerFixture", true)).toBe(true)
    })
  })

  describe("the edition UI alias", () => {
    it("is named by the loader and the seam's tests only", () => {
      expect(allowed("src/edition/load.ts", "@cogpit/edition-ui")).toBe(true)
      expect(allowed("src/edition/__tests__/load.test.ts", "@cogpit/edition-ui", true)).toBe(true)
    })

    it.each([
      ["another core module", "src/App.tsx"],
      ["another core test", "src/__tests__/App.sessionAccess.test.tsx"],
      ["the edition itself", "editions/team/ui/index.ts"],
    ])("is refused to %s", (_what, source) => {
      expect(allowed(source, "@cogpit/edition-ui", source.includes("test"))).toBe(false)
    })
  })

  describe("each part of the edition", () => {
    it.each([
      ["ui", "editions/team/ui/panel/index.tsx", "@cogpit/core/src/edition/sdk"],
      ["ui", "editions/team/ui/panel/index.tsx", "@cogpit/core/src/components/ui/button"],
      ["ui", "editions/team/ui/panel/index.tsx", "@cogpit/core/shared/contracts/identity"],
      ["ui", "editions/team/ui/panel/index.tsx", "../../shared/contracts"],
      ["ui", "editions/team/ui/panel/index.tsx", "./PanelView"],
      ["ui", "editions/team/ui/panel/index.tsx", "react"],
      ["ui", "editions/team/ui/panel/index.tsx", "lucide-react"],
      ["ui", "editions/team/ui/panel/index.tsx", "@base-ui/react/button"],
      ["shared", "editions/team/shared/contracts.ts", "@cogpit/core/shared/contracts/identity"],
      ["server", "editions/team/server/boot.ts", "../shared/contracts"],
      ["server", "editions/team/index.ts", "./server/boot"],
      ["tools", "editions/team/tools/release-tool.ts", "../server/signing/keys"],
      ["UI test", "editions/team/tests/ui/panel.test.tsx", "../../ui/panel"],
      ["UI test", "editions/team/tests/ui/panel.test.tsx", "@cogpit/core/src/__tests__/fixtures"],
      ["UI test", "editions/team/tests/ui/panel.test.tsx", "@cogpit/core/src/lib/capabilities"],
      ["server test", "editions/team/tests/routeFixture.ts", ".."],
    ])("lets %s code import what its part reaches: %s → %s", (_part, source, specifier) => {
      expect(allowed(source, specifier, source.includes("/tests/"))).toBe(true)
    })

    it.each([
      ["UI into the server", "editions/team/ui/panel/index.tsx", "../../server/store"],
      ["UI into the package entry", "editions/team/ui/panel/index.tsx", "@cogpit/team"],
      ["UI into core's server", "editions/team/ui/panel/index.tsx", "@cogpit/core/server/http"],
      ["UI into core's renderer outside the seam", "editions/team/ui/panel/index.tsx", "@cogpit/core/src/lib/auth"],
      ["UI into Node", "editions/team/ui/panel/index.tsx", "node:fs"],
      ["UI into an undeclared package", "editions/team/ui/panel/index.tsx", "left-pad"],
      ["shared contracts into the UI", "editions/team/shared/contracts.ts", "../ui/panel"],
      ["shared contracts into the server", "editions/team/shared/contracts.ts", "../server/store"],
      ["shared contracts into core's server", "editions/team/shared/contracts.ts", "@cogpit/core/server/http"],
      ["shared contracts into a package", "editions/team/shared/contracts.ts", "zod"],
      ["the server into the UI", "editions/team/server/boot.ts", "../ui/panel"],
      ["the package entry into the UI", "editions/team/index.ts", "./ui"],
      ["a UI test into the server", "editions/team/tests/ui/panel.test.tsx", "../../server/store"],
      ["a server test into the UI", "editions/team/tests/panel.test.ts", "../ui/panel"],
    ])("refuses %s", (_what, source, specifier) => {
      expect(allowed(source, specifier, source.includes("/tests/"))).toBe(false)
    })
  })
})

describe("repoTarget", () => {
  const configs = readdirSync(root).filter((name) => /^tsconfig.*\.json$/.test(name))

  // Any other way into the repo would be a way past editionViolation.
  it.each(configs)("knows every path alias %s resolves, and the config sets no baseUrl", (name) => {
    const { config } = ts.readConfigFile(join(root, name), ts.sys.readFile)
    const options: { baseUrl?: string, paths?: Record<string, string[]> } = config.compilerOptions ?? {}
    expect(options.baseUrl).toBeUndefined()
    for (const [alias, [target]] of Object.entries(options.paths ?? {})) {
      expect(repoTarget("server/probe.ts", alias.replace("*", "probe")), alias).toBe(posix.normalize(target.replace("*", "probe")))
    }
  })

  it("leaves every other bare specifier to the packages", () => {
    expect(repoTarget("server/probe.ts", "server/http")).toBeNull()
    expect(repoTarget("editions/team/server/boot.ts", "shared/contracts/identity")).toBeNull()
  })
})
