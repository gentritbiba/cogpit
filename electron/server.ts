import { createServerComposition } from "../server/app-server"

/**
 * Electron adapter retained as the stable worker-facing server API.
 * Environment-neutral composition lives under server/.
 */
export function createAppServer(staticDir: string, userDataDir: string) {
  return createServerComposition(staticDir, userDataDir, {
    mode: "electron",
    viteDevUrl: process.env.ELECTRON_RENDERER_URL,
  })
}
