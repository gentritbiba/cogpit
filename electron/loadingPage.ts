/**
 * The page the window shows the moment the app opens, while the local server
 * starts. It matches the window's own background so the hand-off to the app is
 * seamless, and doubles as a drag handle since the title bar is hidden.
 */
export function loadingPageUrl(markSvg: string | null): string {
  const mark = markSvg
    ? `<img class="mark" alt="" src="data:image/svg+xml;base64,${Buffer.from(markSvg).toString("base64")}">`
    : ""
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cogpit</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px;
    background: #09090b; color: #a1a1aa;
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-app-region: drag; user-select: none;
  }
  .mark { width: 64px; height: 64px; border-radius: 14px; animation: breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity: 0.55; } }
  @media (prefers-reduced-motion: reduce) { .mark { animation: none; } }
</style>
</head>
<body>${mark}<p>Starting Cogpit…</p></body>
</html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
