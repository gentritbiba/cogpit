import type { Plugin, ViteDevServer } from "vite"
import { initBrowserSupport } from "./browser"
import { installSessionCli } from "./sessionCli/install"
import { getDataRoot } from "./config"
import { startCore } from "./core"
import { beginServerStart } from "./lib/installState"
import { resumeLocalDelegations } from "./lib/delegationAuthority"
import { resumeLocalCrewChat } from "./lib/crewChat"
import { isSessionActive } from "./agents/runtimes"
import { attachSocketTransports } from "./socketTransports"

export function ptyPlugin(): Plugin {
  return {
    name: "pty-websocket",
    async configureServer(server: ViteDevServer) {
      // Vite starts the API plugin first, but whichever runs first looks for an
      // earlier Cogpit before the session CLI and browser support write ~/.cogpit.
      await beginServerStart(getDataRoot())
      const core = await startCore({ dataDir: getDataRoot() })
      const browserSupport = initBrowserSupport(isSessionActive)
      installSessionCli()
      resumeLocalDelegations()
      resumeLocalCrewChat()
      // Vite's own listener answers its HMR upgrades, so there is no fallback.
      const transports = attachSocketTransports(server.httpServer!)

      server.httpServer!.on("close", () => {
        void Promise.all([transports.close(), browserSupport.shutdown(), core.release()])
      })
    },
  }
}
