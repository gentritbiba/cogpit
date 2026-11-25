import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { EMPTY_PLUGIN_STATE, RuntimePluginClient } from "./runtimeClient"
import { usePaneLifetime, type PaneLifetime } from "@/contexts/DevicePaneContext"

export function useRuntimePlugins(enabled: boolean) {
  const [client] = useState(() => new RuntimePluginClient())
  const lifetime = usePaneLifetime()
  // Kept through hides, so the client still stops when the pane goes for good.
  const endsWithPane = useRef<PaneLifetime | null>(null)
  useEffect(() => {
    if (!lifetime || endsWithPane.current === lifetime) return
    endsWithPane.current = lifetime
    lifetime.onEnd(() => client.stop())
  }, [client, lifetime])
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, () => EMPTY_PLUGIN_STATE)
  useEffect(() => {
    if (!enabled) {
      client.stop()
      return
    }
    client.start()
    // A machine's pane hidden in the background keeps its plugins, and their
    // host session, for when it comes back; the pane's end stops it for good.
    return () => (lifetime ? client.suspend() : client.stop())
  }, [client, enabled, lifetime])
  return { client, ...state }
}
