// Apply the saved theme before first paint. This is a same-origin external
// script so the standalone server can keep a strict script-src CSP.
(function applyInitialTheme() {
  let theme = "dark"
  try {
    theme = localStorage.getItem("cogpit-theme") || "dark"
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  if (theme === "dark" || theme === "oled") document.documentElement.classList.add("dark")
  if (theme === "oled") document.documentElement.classList.add("theme-oled")

  if (navigator.userAgent.includes("Electron")) {
    document.documentElement.classList.add("electron")
    if (navigator.userAgent.includes("Windows")) {
      document.documentElement.classList.add("electron-win")
    }
  }

  const themeColor = document.querySelector('meta[name="theme-color"]')
  if (themeColor) {
    themeColor.setAttribute("content", theme === "light" ? "#fafafa" : "#09090b")
  }
})()
