import { allStores, allTopLevelSessions } from "../../agents"
import type { AgentProjectEntry } from "../../agents/types"
import { allVisible, type VisibilityCheck } from "../../edition"
import { listedSession } from "../../agents/listedSession"
import { projectLabel } from "./projectLabel"

interface ProjectListing extends AgentProjectEntry {
  shortName: string
}

interface VisibleActivity {
  sessionCount: number
  latestMs: number
}

/** How many sessions of each project the caller may see, and the latest one's time. */
async function visibleActivityByProject(check: VisibilityCheck): Promise<Map<string, VisibleActivity>> {
  const activity = new Map<string, VisibleActivity>()
  for (const { item } of await allVisible(await allTopLevelSessions(), check, listedSession)) {
    const project = activity.get(item.dirName) ?? { sessionCount: 0, latestMs: 0 }
    project.sessionCount += 1
    project.latestMs = Math.max(project.latestMs, item.mtimeMs)
    activity.set(item.dirName, project)
  }
  return activity
}

async function allProjects(): Promise<ProjectListing[]> {
  const projects: ProjectListing[] = []
  for (const store of allStores()) {
    for (const project of await store.listProjects()) {
      projects.push({ ...project, shortName: projectLabel(project.dirName, project.path) })
    }
  }
  return projects
}

/** Null when the caller sees every session, which the stores' own counts already cover. */
async function visibleActivity(check: VisibilityCheck): Promise<Map<string, VisibleActivity> | null> {
  return check.everything ? null : visibleActivityByProject(check)
}

/**
 * The projects the caller may see, newest activity first. A caller who sees
 * every session gets every project on the host. Anyone else gets only the
 * projects holding at least one session they may see, counted and dated by
 * those sessions alone, so the host's other folders stay unnamed to them; a
 * new session starts anywhere through the folder browser.
 */
export async function listProjects(check: VisibilityCheck): Promise<ProjectListing[]> {
  if (check.nothing) return []
  const [projects, activity] = await Promise.all([allProjects(), visibleActivity(check)])
  const listed = activity === null ? projects : projects.flatMap((project) => {
    const visible = activity.get(project.dirName)
    return visible
      ? [{ ...project, sessionCount: visible.sessionCount, lastModified: new Date(visible.latestMs).toISOString() }]
      : []
  })

  return listed.sort((a, b) => {
    if (!a.lastModified) return 1
    if (!b.lastModified) return -1
    return b.lastModified.localeCompare(a.lastModified)
  })
}
