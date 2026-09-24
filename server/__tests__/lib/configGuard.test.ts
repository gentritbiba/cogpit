// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { __resetEditionForTest } from "../../edition"
import { answersUnconfigured } from "../../lib/configGuard"
import { installFakeEdition } from "../edition/fakeEdition"

describe("answersUnconfigured", () => {
  afterEach(() => __resetEditionForTest())

  it("lets discovery, identity and sign-in through before configuration", () => {
    for (const path of ["/api/config", "/api/hello", "/api/me", "/api/auth/verify", "/api/me?probe=1"]) {
      expect(answersUnconfigured(path), path).toBe(true)
    }
  })

  it("refuses every other API path, on segment boundaries only", () => {
    for (const path of ["/api/projects", "/api/messages", "/api/authx", "/api/setup"]) {
      expect(answersUnconfigured(path), path).toBe(false)
    }
  })

  it("adds the paths the running edition leaves unguarded", () => {
    installFakeEdition({ unguardedApiPaths: ["/api/setup"] })

    expect(answersUnconfigured("/api/setup")).toBe(true)
    expect(answersUnconfigured("/api/setup/admin")).toBe(true)
    expect(answersUnconfigured("/api/setupx")).toBe(false)
    expect(answersUnconfigured("/api/projects")).toBe(false)
  })
})
