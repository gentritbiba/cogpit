import { allStores } from "../agents"
import { projectLabel } from "./projectLabel"

/** Every agent's projects, most recently active first. */
export async function listAllProjects() {
  const projects = []
  for (const store of allStores()) {
    for (const project of await store.listProjects()) {
      projects.push({ ...project, shortName: projectLabel(project.dirName, project.path) })
    }
  }
  return projects.sort((a, b) => {
    if (!a.lastModified) return 1
    if (!b.lastModified) return -1
    return b.lastModified.localeCompare(a.lastModified)
  })
}
