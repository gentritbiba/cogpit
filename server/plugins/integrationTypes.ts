import type { PluginIntegrationRequest } from "@cogpit/plugin-contracts"

export interface PluginIntegrationContext {
  workspacePath: string
  signal: AbortSignal
  authorize(): Promise<void>
}
export type PluginIntegrationExecutor = (input: PluginIntegrationRequest, context: PluginIntegrationContext) => Promise<unknown>
