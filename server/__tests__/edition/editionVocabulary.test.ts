// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  countEditionLines,
  editionVocabularyViolations,
  isEditionVocabularyExempt,
} from "../../../scripts/lib/editionVocabulary"

describe("countEditionLines", () => {
  it.each([
    ["the team flag", "if (isTeamEdition()) return"],
    ["an edition compared with the team edition", `if (me.edition === "team") return`],
    ["a negated comparison", `if (hello?.edition !== 'team') return`],
    ["a getter compared", "return getEdition() == `team`"],
    ["the comparison reversed", `if ("team" === config.edition) return`],
    ["a path under the team API", "authFetch(`/api/team/users/${id}`)"],
  ])("counts %s", (_what, line) => {
    expect(countEditionLines(line)).toBe(1)
  })

  it.each([
    ["an edition value, not a comparison", `setMe({ edition: "team" })`],
    ["another comparison with the word team", `if (kind === "team") return`],
    ["the agent-teams API", `fetch("/api/team-watch/abc")`],
    ["the personal edition", `if (edition === "personal") return`],
  ])("ignores %s", (_what, line) => {
    expect(countEditionLines(line)).toBe(0)
  })

  it("counts lines, not matches", () => {
    expect(countEditionLines(`isTeamEdition() && edition === "team"\nplain\nfetch("/api/team/x")`)).toBe(2)
  })
})

describe("isEditionVocabularyExempt", () => {
  it.each(["server/edition/registry.ts", "server/edition/resolve.ts", "server/edition/load.ts", "server/__tests__/edition/load.test.ts"])(
    "exempts %s, which resolves the edition",
    (path) => expect(isEditionVocabularyExempt(path)).toBe(true),
  )

  it.each(["server/edition/index.ts", "server/edition/registry.test.ts", "src/edition/load.ts"])("holds %s to the rule", (path) => {
    expect(isEditionVocabularyExempt(path)).toBe(false)
  })
})

describe("editionVocabularyViolations", () => {
  it("names every file that names the edition, in path order", () => {
    expect(editionVocabularyViolations(new Map([["src/lib/auth.ts", 3], ["server/security.ts", 1]]))).toEqual([
      "server/security.ts: names the edition on 1 line(s); ask server/edition/ or a UI slot instead",
      "src/lib/auth.ts: names the edition on 3 line(s); ask server/edition/ or a UI slot instead",
    ])
  })

  it("passes when no file does", () => {
    expect(editionVocabularyViolations(new Map())).toEqual([])
  })
})
