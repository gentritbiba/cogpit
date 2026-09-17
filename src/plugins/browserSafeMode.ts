import { useSyncExternalStore } from "react"

export const browserSafeMode = () => new URLSearchParams(window.location.search).get("pluginSafeMode") === "1"
const subscribeLocation = (listener: () => void) => { window.addEventListener("popstate", listener); return () => window.removeEventListener("popstate", listener) }
export const useBrowserSafeMode = () => useSyncExternalStore(subscribeLocation, browserSafeMode, () => true)
export function setBrowserSafeMode(enabled: boolean): void {
  const url = new URL(window.location.href)
  if (enabled) url.searchParams.set("pluginSafeMode", "1")
  else url.searchParams.delete("pluginSafeMode")
  window.history.replaceState(window.history.state, "", url)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
