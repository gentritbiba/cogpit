import { describe, expect, it } from "vitest"

import {
  matchesPullRequestTarget,
  matchesSessionSearch,
  parsePullRequestSearch,
} from "../../../shared/session/sessionSearch"

const pullRequest = {
  url: "https://github.com/HonestCMS/cms/pull/157",
  number: 157,
  repo: "HonestCMS/cms",
  title: "Fix inventory search",
  isDraft: false,
  toolCallId: "tool-1",
  timestamp: "2026-09-01T10:00:00.000Z",
}

describe("parsePullRequestSearch", () => {
  it.each([
    ["#157", { number: 157, repoHint: null }],
    ["honest-cms #157", { number: 157, repoHint: "honest-cms" }],
    ["honest-cms#157", { number: 157, repoHint: "honest-cms" }],
    ["PR #157 on honest-cms", { number: 157, repoHint: "honest-cms" }],
    ["PR 157", { number: 157, repoHint: null }],
    [
      "https://github.com/HonestCMS/cms/pull/157",
      { number: 157, repoHint: "honestcms/cms" },
    ],
  ])("parses %s", (query, expected) => {
    expect(parsePullRequestSearch(query)).toEqual(expected)
  })

  it("leaves ordinary numeric text to the normal session search", () => {
    expect(parsePullRequestSearch("release 157")).toBeNull()
  })
})

describe("PR session matching", () => {
  it("matches an exact PR number without confusing it with a prefix", () => {
    expect(matchesSessionSearch({ pullRequests: [pullRequest] }, "#157")).toBe(true)
    expect(matchesSessionSearch({ pullRequests: [pullRequest] }, "#15")).toBe(false)
  })

  it("uses the local project name when the GitHub repository has a different name", () => {
    expect(matchesSessionSearch(
      { pullRequests: [pullRequest], cwd: "/work/honest-cms" },
      "honest-cms #157",
    )).toBe(true)
  })

  it("matches a worked-on reference using session repository context", () => {
    expect(matchesPullRequestTarget(
      { number: 157, repo: "" },
      { number: 157, repoHint: "honest-cms" },
      ["/work/honest-cms"],
    )).toBe(true)
  })

  it("matches a pasted GitHub URL when the command relied on the current repository", () => {
    expect(matchesPullRequestTarget(
      { number: 157, repo: "" },
      { number: 157, repoHint: "honestcms/cms" },
      ["/work/honest-cms"],
    )).toBe(true)
  })

  it("does not let local context override an explicitly different repository", () => {
    expect(matchesPullRequestTarget(
      { number: 157, repo: "someone-else/cms" },
      { number: 157, repoHint: "honestcms/cms" },
      ["/work/honest-cms"],
    )).toBe(false)
  })
})
