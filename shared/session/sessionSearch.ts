import type { SessionPullRequest, SessionPullRequestReference } from "./prLinks"

export interface PullRequestSearch {
  number: number
  /** Repository name, `owner/repo`, or local project name supplied with the number. */
  repoHint: string | null
}

interface SearchableSession {
  aiTitle?: string
  name?: string
  slug?: string
  customTitle?: string
  firstUserMessage?: string
  lastUserMessage?: string
  model?: string
  gitBranch?: string
  agentName?: string
  teamName?: string
  sessionId?: string
  cwd?: string
  projectShortName?: string
  pullRequests?: SessionPullRequest[]
}

const PULL_REQUEST_URL = /(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i
const COMPACT_REFERENCE = /^([\w.-]+(?:\/[\w.-]+)?)#(\d+)$/
const HASH_NUMBER = /(?:^|\s)#(\d+)(?=\s|$)/
const NAMED_NUMBER = /^(?:pr|pull\s+request)\s*#?(\d+)$/i

function validNumber(raw: string): number | null {
  const number = Number(raw)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function cleanRepoHint(raw: string): string | null {
  const hint = raw.trim()
    .replace(/^(?:pr|pull\s+request)\b/i, "")
    .trim()
    .replace(/^(?:in|on)\s+/i, "")
  if (!hint || /^(?:pr|pull\s+request)$/i.test(hint)) return null
  return hint.toLowerCase()
}

/**
 * Recognizes the PR forms people naturally paste into session search:
 * `#157`, `honest-cms #157`, `honest-cms#157`, `PR 157`, and a GitHub URL.
 */
export function parsePullRequestSearch(query: string): PullRequestSearch | null {
  const value = query.trim()
  if (!value) return null

  const url = PULL_REQUEST_URL.exec(value)
  if (url) {
    const number = validNumber(url[3])
    return number === null ? null : { number, repoHint: `${url[1]}/${url[2]}`.toLowerCase() }
  }

  const compact = COMPACT_REFERENCE.exec(value)
  if (compact) {
    const number = validNumber(compact[2])
    return number === null ? null : { number, repoHint: compact[1].toLowerCase() }
  }

  const hash = HASH_NUMBER.exec(value)
  if (hash) {
    const number = validNumber(hash[1])
    if (number === null) return null
    const remainder = `${value.slice(0, hash.index)} ${value.slice(hash.index + hash[0].length)}`
    return { number, repoHint: cleanRepoHint(remainder) }
  }

  const named = NAMED_NUMBER.exec(value)
  if (!named) return null
  const number = validNumber(named[1])
  return number === null ? null : { number, repoHint: null }
}

function repoMatches(value: string | undefined, hint: string): boolean {
  if (!value) return false
  const repo = value.toLowerCase().replace(/\.git$/, "")
  return repo === hint || repo.endsWith(`/${hint}`) || hint.endsWith(`/${repo}`)
}

function localProjectMatches(value: string | undefined, hint: string): boolean {
  if (!value) return false
  const project = value.toLowerCase().replace(/\.git$/, "").split(/[\\/]/).filter(Boolean).at(-1)
  if (!project) return false
  const normalizedProject = project.replace(/[^a-z0-9]/g, "")
  return hint.split("/").some((part) => part.replace(/[^a-z0-9]/g, "") === normalizedProject)
}

export function matchesPullRequestTarget(
  target: Pick<SessionPullRequestReference, "number" | "repo">,
  search: PullRequestSearch,
  repositoryContext: Array<string | undefined> = [],
): boolean {
  if (target.number !== search.number) return false
  const hint = search.repoHint
  if (!hint) return true
  if (target.repo && hint.includes("/")) return repoMatches(target.repo, hint)
  if (repoMatches(target.repo, hint)) return true
  return repositoryContext.some((value) => localProjectMatches(value, hint))
}

/** Client-side match for the sessions already in memory. */
export function matchesSessionSearch(
  session: SearchableSession,
  query: string,
  extraFields: Array<string | undefined> = [],
): boolean {
  const pullRequestSearch = parsePullRequestSearch(query)
  if (pullRequestSearch) {
    const context = [session.cwd, session.projectShortName, ...extraFields]
    return session.pullRequests?.some((pullRequest) => (
      matchesPullRequestTarget(pullRequest, pullRequestSearch, context)
    )) ?? false
  }

  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [
    ...extraFields,
    session.aiTitle,
    session.name,
    session.slug,
    session.customTitle,
    session.firstUserMessage,
    session.lastUserMessage,
    session.model,
    session.gitBranch,
    session.agentName,
    session.teamName,
    session.sessionId,
    session.cwd,
    session.projectShortName,
  ].some((field) => field?.toLowerCase().includes(normalized))
}
