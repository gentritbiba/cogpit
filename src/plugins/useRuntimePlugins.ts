import { useEffect, useState, useSyncExternalStore } from "react"
import { EMPTY_PLUGIN_STATE, RuntimePluginClient } from "./runtimeClient"

export function useRuntimePlugins(enabled: boolean) {
  const [client] = useState(() => new RuntimePluginClient())
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, () => EMPTY_PLUGIN_STATE)
  useEffect(() => {
    if (!enabled) return
    client.start()
    return () => client.stop()
  }, [client, enabled])
  return { client, ...state }
}
