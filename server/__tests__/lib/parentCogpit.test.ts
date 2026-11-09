import { describe, expect, it } from "vitest"
import { detachFromParentCogpit } from "../../lib/parentCogpit"

describe("detachFromParentCogpit", () => {
  it("drops the parent's session, orchestration store and port when started inside an agent", () => {
    const env: NodeJS.ProcessEnv = { COGPIT_SESSION_ID: "parent", COGPIT_ORCHESTRATION_ROOT: "/parent/data", COGPIT_PORT: "19384", COGPIT_HOST: "127.0.0.1" }
    detachFromParentCogpit(env)
    expect(env).toEqual({ COGPIT_HOST: "127.0.0.1" })
  })

  it("keeps an explicit orchestration root and port outside an agent", () => {
    const env: NodeJS.ProcessEnv = { COGPIT_ORCHESTRATION_ROOT: "/isolated", COGPIT_PORT: "5200" }
    detachFromParentCogpit(env)
    expect(env).toEqual({ COGPIT_ORCHESTRATION_ROOT: "/isolated", COGPIT_PORT: "5200" })
  })
})
