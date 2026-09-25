/**
 * The environment Cogpit hands an agent: `~/.cogpit/bin` first on PATH, so its
 * `agent-browser` calls land in the managed browser tree and `cogpit-session`
 * resolves; the Cogpit session id the shim files throwaway browsers under and
 * the session CLI records as the parent of sessions the agent starts; and the
 * port this server listens on.
 *
 * A spawn that serves every session rather than one passes `NO_COGPIT_SESSION`,
 * which the shim rejects — the alternative, a stand-in that looks like an id,
 * makes every named browser read as driven by a session that does not exist.
 */
import { existsSync } from "node:fs"
import { delimiter } from "node:path"
import { serverPort } from "../lib/portFile"
import { binDir, pluginDir, shimPath } from "./paths"
import { pluginManifestFile } from "./skill"

/** True once `~/.cogpit/bin` exists: it holds the session CLI and, when installed, the shim. */
export function agentBinInstalled(): boolean {
  return existsSync(binDir())
}

/** True once agent-browser is installed: the shim is written only then. */
export function browserShimInstalled(): boolean {
  return existsSync(shimPath())
}

/** Windows spells it `Path`, and a copied env is a plain object, so the key is found by name. */
function pathKey(env: NodeJS.ProcessEnv): string {
  if ("PATH" in env) return "PATH"
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
}

export function cogpitAgentEnv(base: NodeJS.ProcessEnv, cogpitSessionId: string): NodeJS.ProcessEnv {
  const port = serverPort()
  const env: NodeJS.ProcessEnv = {
    ...base,
    COGPIT_SESSION_ID: cogpitSessionId,
    ...(port !== null ? { COGPIT_PORT: String(port) } : {}),
  }
  if (!agentBinInstalled()) return env
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
