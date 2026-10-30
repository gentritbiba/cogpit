// @vitest-environment node
import { describe, expect, it } from "vitest"
import { PERSONAL_EDITION } from "../../edition"
import { missingEditionMembers } from "../../edition/moduleShape"

describe("an edition's unattended hook", () => {
  it("is optional, but checked member by member when present", () => {
    expect(missingEditionMembers(PERSONAL_EDITION)).toEqual([])
    expect(missingEditionMembers({ ...PERSONAL_EDITION, unattended: { issue: async () => null, resolve: async () => null } })).toEqual(["unattended.revoke"])
    expect(missingEditionMembers({ ...PERSONAL_EDITION, unattended: { issue: async () => null, resolve: async () => null, revoke: async () => {} } })).toEqual([])
  })
})

describe("an edition's signed webhook ingress flag", () => {
  const auth = { middleware() {}, login: async () => {}, admitsSocket: () => true, administers: () => true, sessions: Object.fromEntries(["persist", "restore", "touch", "remove", "removeForUser", "clear", "flush"].map((name) => [name, () => {}])) }
  it("is optional, but must be a boolean when present", () => {
    expect(missingEditionMembers({ ...PERSONAL_EDITION, auth })).toEqual([])
    expect(missingEditionMembers({ ...PERSONAL_EDITION, auth: { ...auth, signedWebhookIngress: true } })).toEqual([])
    expect(missingEditionMembers({ ...PERSONAL_EDITION, auth: { ...auth, signedWebhookIngress: "yes" } })).toEqual(["auth.signedWebhookIngress"])
  })
})
