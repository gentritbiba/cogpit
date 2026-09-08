# Why named browsers open in a window (Cloudflare, 2026-09-08)

Clicking "Verify you are human" on `dash.cloudflare.com` in the Browser panel
restarted the challenge every time. This records what was measured so the
launch flags in `server/browser/shim.ts` are not undone by accident.

## Findings

All probes ran Google Chrome 152 on macOS against `https://dash.cloudflare.com/login`,
whose login form carries a Turnstile widget that fails at load time
(`There was a problem with verification`, console error `600010`, sign-in
disabled) when it rejects the browser. That made an automated oracle; no
challenge was ever solved by script.

| Launch | `navigator.webdriver` | Login-form Turnstile |
|---|---|---|
| agent-browser's headless shell (Chromium 145) | true | interstitial, HTTP 403 even with `cf_clearance` |
| Chrome, `--headless=new`, automation flag off | false | interstitial; user agent still says `HeadlessChrome` |
| Chrome window, `--remote-debugging-port=0` only | true | rejected |
| Chrome window, port + `--disable-blink-features=AutomationControlled` | false | accepted, sign-in enabled |
| same, with a CDP client that calls `Runtime.enable` | false | accepted |
| same, through agent-browser 0.16.3 (Playwright adds `--enable-automation`) | false | accepted |

Two causes, then:

1. Headless Chromium is refused by user agent. No flag fixes that; only a real
   window does.
2. Chromium sets `navigator.webdriver` whenever a debugging port is open, even
   in a window, and Turnstile fails on that alone. `--disable-blink-features=AutomationControlled`
   turns it off. Playwright's `--enable-automation` and `--remote-debugging-pipe`
   do not override it.

Cogpit's viewer was verified against the windowed browser through its real
modules: shim install, launch, `BrowserViewer` attach with screencast and
viewport override, a forwarded click and keystroke landing in the email field.
Frames stream while the window is behind other windows or minimized, and
launching does not take focus from Cogpit. Loading the dashboard root in a
clean windowed Chrome goes straight to the login form with no interstitial.

## Not done

- No user-agent spoofing, `navigator.webdriver` override or stealth script.
  The browser is a normal Chrome whose only automation surface is the
  debugging port every DevTools session also opens.
- macOS clamps `--window-position` back on screen, and Chrome has no
  start-minimized flag, so the window is visible behind Cogpit.
- agent-browser 0.37.0 (native backend) was tried by the earlier
  investigation and hung in windowed mode; the fix stays on the installed
  0.16.3 and its `AGENT_BROWSER_HEADED` / `AGENT_BROWSER_EXECUTABLE_PATH`
  environment.
