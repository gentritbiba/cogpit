import { randomUUID } from "node:crypto"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import type { ProviderInstance } from "../../shared/contracts/orchestration"
import { getDataRoot } from "../config"
import { orchestrationStore } from "../orchestration/storage"
import { OrchestrationError } from "../orchestration/store"
import { findExecutableOnPath } from "../lib/binaryResolver"
import { providerInstanceEnvironment } from "./instanceRuntime"
export function providerSetupCommand(instance: ProviderInstance): string {
  const env = providerInstanceEnvironment(instance, process.env.COGPIT_ORCHESTRATION_ROOT || getDataRoot())
  const descriptor = descriptorFor(instance.agent)
  const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", descriptor.cli.homeEnvVar, descriptor.cli.bundledBySdk ? "CLAUDE_CONFIG_DIR" : null].filter((key): key is string => key !== null)
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  if (process.platform === "win32") return keys.map((key) => `$env:${key}=${quote(env[key]!)}`).join("; ") + `; & ${quote(instance.executable || descriptor.binName)}`
  return `env ${keys.map((key) => `${key}=${quote(env[key]!)}`).join(" ")} ${instance.agent === "acp" ? "<provider-login-command>" : quote(instance.executable || descriptor.binName)}`
}

export function providerInstances(): ProviderInstance[] { return process.env.COGPIT_AGENT_WORKER === "1" ? [] : orchestrationStore().instances().filter((instance) => !instance.retired) }
export function providerInstance(id: string): ProviderInstance {
  const found = providerInstances().find((instance) => instance.id === id)
  if (!found) throw new OrchestrationError(404, "Provider instance not found")
  return found
}
export async function createProviderInstance(input: { agent?: unknown; label?: unknown; executable?: unknown; args?: unknown }): Promise<ProviderInstance> {
  if (!AGENT_KINDS.includes(input.agent as AgentKind) || typeof input.label !== "string" || !input.label.trim() || input.label.length > 80) throw new OrchestrationError(400, "An agent and a label of 1–80 characters are required")
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 32 || !input.args.every((arg) => typeof arg === "string" && arg.length <= 4096 && !arg.includes("\0")))) throw new OrchestrationError(400, "args must contain up to 32 plain arguments")
  const descriptor = descriptorFor(input.agent as AgentKind)
  let executable: string | undefined
  if (input.executable !== undefined && input.executable !== "") {
    if (typeof input.executable !== "string" || input.executable.includes("\0")) throw new OrchestrationError(400, "Invalid executable")
    executable = findExecutableOnPath(input.executable) ?? undefined
    if (!executable) throw new OrchestrationError(400, "Executable was not found on this server")
  }
  if (descriptor.kind === "acp" && !executable) throw new OrchestrationError(400, "An ACP executable is required")
  if (descriptor.kind !== "acp" && (input.args as string[] | undefined)?.length) throw new OrchestrationError(400, "Custom arguments are supported for ACP instances")
  const id = randomUUID()
  const homeDir = join(process.env.COGPIT_ORCHESTRATION_ROOT || getDataRoot(), "provider-instances", id)
  await mkdir(homeDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(homeDir, 0o700)
  const instance: ProviderInstance = { id, agent: descriptor.kind, label: input.label.trim(), homeDir, executable, args: input.args as string[] | undefined, createdAt: Date.now() }
  await writeFile(join(homeDir, "config.json"), JSON.stringify({ providerInstance: { id, agent: descriptor.kind }, claudeDir: homeDir, claudeDirIsPlaceholder: descriptor.cli.homeIsDiscoverable, ...(descriptor.cli.bundledBySdk && executable ? { agentExecutable: { source: "custom", path: executable } } : {}) }), { mode: 0o600 })
  orchestrationStore().putInstance(instance)
  return instance
}
