import { createServerComposition } from "./app-server"

/** Standalone adapter for the shared server composition. */
export function createStandaloneAppServer(
  staticDir: string,
  userDataDir: string,
) {
  return createServerComposition(staticDir, userDataDir, {
    mode: "standalone",
    viteDevUrl: process.env.ELECTRON_RENDERER_URL,
  })
}
