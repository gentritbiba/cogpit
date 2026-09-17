export * from "@cogpit/plugin-integrations/github"

/** A Cogpit session that opened or worked on pull requests of the repository. */
export interface GitHubPullSession {
  dirName: string
  fileName: string
  sessionId: string
  title: string
  numbers: number[]
}

export interface GitHubPullSessionsResponse {
  repository: string
  sessions: GitHubPullSession[]
  /** Session transcripts still being scanned; poll again while above zero. */
  pending: number
}
