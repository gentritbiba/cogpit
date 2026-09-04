import clickup from "./clickup/plugin"
import github from "./github/plugin"
import vercelDeployments from "./vercel-deployments/plugin"
import type { CogpitPlugin } from "@/plugin-api"

/**
 * Compile-time Cogpit plugins. Add an imported plugin to this list and rebuild
 * the app. Runtime installation and activation are deliberately deferred.
 */
export const plugins: readonly CogpitPlugin[] = [github, clickup, vercelDeployments]
