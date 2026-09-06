/**
 * The environment Cogpit hands an agent so its `agent-browser` calls land in the
 * managed browser tree: the shim first on PATH, and the Cogpit session id the
 * shim files throwaway browsers under.
 */
import { existsSync } from "node:fs"
import { delimiter } from "node:path"
import { binDir, pluginDir, shimPath } from "./paths"
import { pluginManifestFile } from "./skill"

export function browserAgentEnv(base: NodeJS.ProcessEnv, cogpitSessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, COGPIT_SESSION_ID: cogpitSessionId }
  if (!existsSync(shimPath())) return env
  const dir = binDir()
  const path = base.PATH ?? ""
  if (path.split(delimiter)[0] === dir) return env
  env.PATH = path ? `${dir}${delimiter}${path}` : dir
  return env
}

export function browserPluginPaths(): string[] {
  return existsSync(pluginManifestFile()) ? [pluginDir()] : []
}
