import { applyTheme } from "./lib/themes"
import { shownDeviceTheme } from "./lib/deviceThemes"
import { getActiveDeviceId } from "./lib/device"

applyTheme(shownDeviceTheme(getActiveDeviceId()))

if (navigator.userAgent.includes("Electron")) {
  document.documentElement.classList.add("electron")
  if (navigator.userAgent.includes("Windows")) document.documentElement.classList.add("electron-win")
}
