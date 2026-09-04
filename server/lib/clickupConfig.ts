import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"

/**
 * ClickUp credentials and project links, in ~/.cogpit/clickup.json with an
 * environment override for the token so a headless box needs no file.
 *
 * Kept out of AppConfig on purpose: the token is a bearer secret and AppConfig
 * is served to the renderer.
 */
export interface ClickUpConfig {
  token: string | null
  /** Personal token was set from the environment; the file cannot change it. */
  tokenFromEnv: boolean
  /** Absolute project path → linked ClickUp list id. */
  projects: Record<string, string>
}

export const CLICKUP_CONFIG_FILE = join(homedir(), ".cogpit", "clickup.json")
const TOKEN_PATTERN = /^pk_[A-Za-z0-9_]{8,}$/

let configPath = CLICKUP_CONFIG_FILE

/** Test seam: point the store at a temporary file. */
export function setClickUpConfigPath(path: string): void {
  configPath = path
}

export function isClickUpToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value)
}

interface StoredFile {
  token?: string
  projects?: Record<string, string>
}

async function readStored(): Promise<StoredFile> {
  let raw: string
  try {
    raw = await readFile(configPath, "utf8")
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const source = parsed as Record<string, unknown>
    const projects: Record<string, string> = {}
    const storedProjects = source.projects
    if (typeof storedProjects === "object" && storedProjects !== null) {
      for (const [path, listId] of Object.entries(storedProjects as Record<string, unknown>)) {
        if (typeof listId === "string" && /^\d+$/.test(listId)) projects[path] = listId
      }
    }
    return { token: isClickUpToken(source.token) ? source.token : undefined, projects }
  } catch {
    return {}
  }
}

/** Cogpit's own name first; ClickUp's conventional one so an existing shell export works. */
const TOKEN_ENV_VARS = ["COGPIT_CLICKUP_TOKEN", "CLICKUP_API_TOKEN"] as const

export async function loadClickUpConfig(): Promise<ClickUpConfig> {
  const stored = await readStored()
  const envToken = TOKEN_ENV_VARS.map((name) => process.env[name]?.trim()).find(isClickUpToken)
  if (envToken) {
    return { token: envToken, tokenFromEnv: true, projects: stored.projects ?? {} }
  }
  return { token: stored.token ?? null, tokenFromEnv: false, projects: stored.projects ?? {} }
}

async function writeStored(next: StoredFile): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  const file: StoredFile = { projects: next.projects ?? {} }
  if (next.token) file.token = next.token
  await writeOwnerOnlyJson(configPath, file)
}

export async function saveClickUpToken(token: string | null): Promise<void> {
  const stored = await readStored()
  await writeStored({ ...stored, token: token ?? undefined })
}

export async function saveClickUpProjectLink(projectPath: string, listId: string | null): Promise<void> {
  const stored = await readStored()
  const projects = { ...stored.projects }
  if (listId === null) delete projects[projectPath]
  else projects[projectPath] = listId
  await writeStored({ ...stored, projects })
}
