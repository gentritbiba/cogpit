// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  resolveEdition,
  initEdition,
  getEdition,
  isTeamEdition,
  __resetEditionForTest,
} from "../team/edition"

// ── resolveEdition (pure) ───────────────────────────────────────────────

describe("resolveEdition", () => {
  it("honors COGPIT_EDITION=team in the standalone shell", () => {
    expect(resolveEdition({ COGPIT_EDITION: "team" }, undefined, "standalone")).toBe("team")
  })

  it("forces personal in the electron shell even when env says team", () => {
    expect(resolveEdition({ COGPIT_EDITION: "team" }, undefined, "electron")).toBe("personal")
  })

  it("forces personal in the dev shell even when env says team", () => {
    expect(resolveEdition({ COGPIT_EDITION: "team" }, undefined, "dev")).toBe("personal")
  })

  it("honors a team config edition in the standalone shell", () => {
    expect(resolveEdition({}, "team", "standalone")).toBe("team")
  })

  it("forces personal for a team config edition outside standalone", () => {
    expect(resolveEdition({}, "team", "electron")).toBe("personal")
    expect(resolveEdition({}, "team", "dev")).toBe("personal")
  })

  it("treats casing variants and garbage env values as personal", () => {
    expect(resolveEdition({ COGPIT_EDITION: "TEAM" }, undefined, "standalone")).toBe("personal")
    expect(resolveEdition({ COGPIT_EDITION: "enterprise" }, undefined, "standalone")).toBe("personal")
    expect(resolveEdition({ COGPIT_EDITION: "" }, undefined, "standalone")).toBe("personal")
  })

  it("defaults to personal when neither env nor config opts in", () => {
    expect(resolveEdition({}, undefined, "standalone")).toBe("personal")
  })

  it("lets an explicit env personal override a team config edition", () => {
    expect(resolveEdition({ COGPIT_EDITION: "personal" }, "team", "standalone")).toBe("personal")
  })

  it("falls back to the config edition when the env value is invalid", () => {
    expect(resolveEdition({ COGPIT_EDITION: "TEAM" }, "team", "standalone")).toBe("team")
  })
})

// ── module state ────────────────────────────────────────────────────────

describe("edition module state", () => {
  const originalEnv = process.env.COGPIT_EDITION

  beforeEach(() => {
    delete process.env.COGPIT_EDITION
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.COGPIT_EDITION
    else process.env.COGPIT_EDITION = originalEnv
    __resetEditionForTest()
  })

  it("defaults to personal before initEdition runs", () => {
    expect(getEdition()).toBe("personal")
    expect(isTeamEdition()).toBe(false)
  })

  it("resolves team from process.env for the standalone shell", () => {
    process.env.COGPIT_EDITION = "team"
    initEdition({ shell: "standalone" })
    expect(getEdition()).toBe("team")
    expect(isTeamEdition()).toBe(true)
  })

  it("forces personal for the electron shell even when env says team", () => {
    process.env.COGPIT_EDITION = "team"
    initEdition({ shell: "electron" })
    expect(getEdition()).toBe("personal")
    expect(isTeamEdition()).toBe(false)
  })

  it("forces personal for the dev shell even when env says team", () => {
    process.env.COGPIT_EDITION = "team"
    initEdition({ shell: "dev" })
    expect(getEdition()).toBe("personal")
  })

  it("resolves team from the config edition for the standalone shell", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    expect(getEdition()).toBe("team")
    expect(isTeamEdition()).toBe(true)
  })

  it("returns to personal after __resetEditionForTest", () => {
    process.env.COGPIT_EDITION = "team"
    initEdition({ shell: "standalone" })
    __resetEditionForTest()
    expect(getEdition()).toBe("personal")
    expect(isTeamEdition()).toBe(false)
  })
})
