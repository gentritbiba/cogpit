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
