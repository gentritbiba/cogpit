import { useCallback, useEffect, useState } from "react"

/** The desktop app's own update, as the main process reports it; idle everywhere else. */
export function useCogpitUpdate() {
  const [update, setUpdate] = useState<ElectronUpdateState>({ status: "idle" })
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const api = window.electronUpdater
    if (!api) return
    let live = true
    void api.getState().then((state) => { if (live) setUpdate(state) })
    const unsubscribe = api.onState((state) => {
      setUpdate(state)
      setRestarting(false)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  const install = useCallback(() => {
    setRestarting(true)
    void window.electronUpdater?.install()
  }, [])

  return { update, restarting, install }
}
