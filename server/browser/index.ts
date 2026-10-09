/**
 * Turning the managed browser tree on and off: the directories it lives in, the
 * shim that goes first on every agent's PATH, the plugin that carries the skill
 * to the sessions Cogpit starts, and the sweeper that reaps daemons a finished
 * session left behind.
 *
 * This module writes inside Cogpit's own tree. The session CLI startup hook
 * separately refreshes the bundled skills in existing agent config roots.
 *
 * Each step stands alone. A read-only home, or a machine without agent-browser,
 * costs the Browser panel and nothing else — the server still starts.
 */
import { mkdirSync } from "node:fs"
import { shutdownBrowsers, startSweeper } from "./daemons"
import { profilesDir, sharedRunDir } from "./paths"
import { ensureShim, findRealAgentBrowser, findVisibleBrowser } from "./shim"
import { ensurePlugin } from "./skill"

export interface BrowserSupport {
  shutdown(): Promise<void>
}

function attempt(step: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`Browser support: ${step} failed; the Browser panel may not work.`, error)
  }
}

export function initBrowserSupport(isCogpitSessionLive: (id: string) => boolean): BrowserSupport {
  let stopSweeper: (() => void) | null = null

  attempt("creating the browser directories", () => {
    mkdirSync(profilesDir(), { recursive: true })
    mkdirSync(sharedRunDir(), { recursive: true })
  })
  attempt("installing the agent-browser shim", () => {
    ensureShim(findRealAgentBrowser(), { visibleBrowser: findVisibleBrowser() })
  })
  attempt("writing the bundled skills plugin", () => {
    ensurePlugin()
  })
  attempt("starting the daemon sweeper", () => {
    stopSweeper = startSweeper(isCogpitSessionLive)
  })

  return {
    async shutdown() {
      const stop = stopSweeper
      stopSweeper = null
      if (stop) attempt("stopping the daemon sweeper", stop)
      await shutdownBrowsers().catch((error: unknown) => {
        console.error("Browser support: stopping the browser daemons failed.", error)
      })
    },
  }
}
