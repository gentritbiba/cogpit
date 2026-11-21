import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("electronUpdater", {
  getState: () => ipcRenderer.invoke("update:get-state"),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => cb(state)
    ipcRenderer.on("update:state", listener)
    return () => { ipcRenderer.removeListener("update:state", listener) }
  },
  install: () => ipcRenderer.invoke("update:install"),
})

contextBridge.exposeInMainWorld("electronPerformance", {
  getSnapshot: () => ipcRenderer.invoke("performance:get-snapshot"),
})
