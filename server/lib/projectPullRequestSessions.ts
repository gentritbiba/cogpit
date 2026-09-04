import { realpath } from "node:fs/promises"
import type { GitHubPullSession } from "../../shared/contracts/github"
import { allStores } from "../agents"
import { getSessionMeta, getSessionStatus } from "../helpers"
import { getOrLoadSessionMeta } from "./sessionMetaCache"
import { getSessionPrSearchSnapshot } from "./sessionPrSearchIndex"

export interface ProjectPullRequestSessions {
  sessions: GitHubPullSession[]
  pending: number
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * Every top-level session of a project that opened or addressed a pull request
 * of `repository` ("owner/name"), newest first. References that name no
 * repository are trusted, since the session ran inside this project.
 */
export async function listProjectPullRequestSessions(
  projectPath: string,
  repository: string,
): Promise<ProjectPullRequestSessions> {
  const root = await canonical(projectPath)
  // Sessions repeat a handful of project paths; resolve each path once.
  const canonicalPaths = new Map<string, Promise<string>>()
  const candidates = []
  for (const store of allStores()) {
    for (const session of await store.listTopLevelSessions()) {
      if (!session.projectPath) continue
      let resolved = canonicalPaths.get(session.projectPath)
      if (!resolved) {
        resolved = canonical(session.projectPath)
        canonicalPaths.set(session.projectPath, resolved)
      }
      if (await resolved !== root) continue
      candidates.push(session)
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const snapshot = await getSessionPrSearchSnapshot(candidates)
  const repositoryName = repository.toLowerCase()
  const sessions = await Promise.all(candidates.map(async (candidate) => {
    const references = snapshot.byFile.get(candidate.filePath)?.references ?? []
    const numbers = [...new Set(
      references
        .filter((reference) => !reference.repo || reference.repo.toLowerCase() === repositoryName)
        .map((reference) => reference.number),
    )]
    if (numbers.length === 0) return null

    const { meta } = await getOrLoadSessionMeta(candidate.filePath, candidate.mtimeMs, async () => {
      const [sessionMeta, status] = await Promise.all([
        getSessionMeta(candidate.filePath),
        getSessionStatus(candidate.filePath),
      ])
      return { meta: sessionMeta, status }
    })
    return {
      dirName: candidate.dirName,
      fileName: candidate.fileName,
      sessionId: candidate.sessionId || meta.sessionId || candidate.fileName.replace(/\.jsonl$/, ""),
      title: meta.customTitle || meta.aiTitle || meta.firstUserMessage || meta.slug || "",
      numbers,
    }
  }))

  return {
    sessions: sessions.filter((session): session is GitHubPullSession => session !== null),
    pending: snapshot.pending,
  }
}
