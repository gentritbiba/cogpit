import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("electronUpdater", {
  onUpdateAvailable: (cb: (info: { version: string; url: string; platform: string }) => void) => {
    ipcRenderer.on("update-available", (_event, info) => cb(info))
  },
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => {
    ipcRenderer.on("update-downloaded", (_event, info) => cb(info))
  },
  dismissVersion: (version: string) => {
    ipcRenderer.send("dismiss-update", version)
  },
})
