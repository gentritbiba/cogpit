/**
 * The environment Cogpit hands an agent so its `agent-browser` calls land in the
 * managed browser tree: the shim first on PATH, and the Cogpit session id the
 * shim files throwaway browsers under and stamps on a named browser's `.driver`.
 *
 * A spawn that serves every session rather than one passes `NO_COGPIT_SESSION`,
 * which the shim rejects — the alternative, a stand-in that looks like an id,
 * makes every named browser read as driven by a session that does not exist.
 */
import { existsSync } from "node:fs"
import { delimiter } from "node:path"
import { binDir, pluginDir, shimPath } from "./paths"
import { pluginManifestFile } from "./skill"

/** True once agent-browser is installed: the shim is written only then. */
export function browserShimInstalled(): boolean {
  return existsSync(shimPath())
}

/** Windows spells it `Path`, and a copied env is a plain object, so the key is found by name. */
function pathKey(env: NodeJS.ProcessEnv): string {
  if ("PATH" in env) return "PATH"
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
}

export function browserAgentEnv(base: NodeJS.ProcessEnv, cogpitSessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, COGPIT_SESSION_ID: cogpitSessionId }
  if (!browserShimInstalled()) return env
  const dir = binDir()
  const key = pathKey(base)
  const path = base[key] ?? ""
  if (path.split(delimiter)[0] === dir) return env
  env[key] = path ? `${dir}${delimiter}${path}` : dir
  return env
}

export function browserPluginPaths(): string[] {
  const manifest = pluginManifestFile()
  return manifest !== null && existsSync(manifest) ? [pluginDir()] : []
}
