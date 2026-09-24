import { useEffect, useState } from "react"
import { useCapability } from "@/hooks/useCapability"
import { useDevices } from "@/hooks/useDevices"
import { authFetch, isRemoteClient } from "@/lib/auth"
import { readJson } from "@/lib/httpJson"

/**
 * The machine whose folders the folder browser shows, when it is not the one
 * the user sits at: the hub device in use, by the name it has in the hub, else
 * the server a remote browser is connected to, by the name it reports. Null on
 * the local machine.
 */
export function useFolderHostName(): string | null {
  // Only an account that manages devices may use the hub; for any other, asking is a 403.
  const { activeDevice } = useDevices({ enabled: useCapability("manageDevices") })
  const remoteServer = !activeDevice && isRemoteClient()
  const [serverName, setServerName] = useState<string | null>(null)

  useEffect(() => {
    if (!remoteServer) return
    const controller = new AbortController()
    authFetch("/api/hello", { signal: controller.signal })
      .then(readJson)
      .then((hello) => {
        if (typeof hello?.name === "string" && hello.name) setServerName(hello.name)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [remoteServer])

  return activeDevice?.name ?? (remoteServer ? serverName : null)
}
