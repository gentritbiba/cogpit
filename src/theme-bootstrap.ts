import { applyTheme, readSavedTheme } from "./lib/themes"

applyTheme(readSavedTheme())

if (navigator.userAgent.includes("Electron")) {
  document.documentElement.classList.add("electron")
  if (navigator.userAgent.includes("Windows")) document.documentElement.classList.add("electron-win")
}
