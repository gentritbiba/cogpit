/**
 * The shim Cogpit puts first on every agent's PATH. agent-browser's first call
 * spawns a daemon that inherits that call's environment, so the shim is where
 * each session's profile, socket dir and Chromium flags get decided.
 *
 * macOS and Linux get one bash script. Windows gets the same routing as a Node
 * script plus two launchers for it: a `.cmd` for cmd.exe, PowerShell and
 * Cogpit's own spawns, and a bash delegate for Git Bash, which some agent
 * shell tools run there. agent-browser needs `node` on PATH to start its
 * daemon, so the launchers may rely on it too.
 */
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import { join, posix, resolve, win32 } from "node:path"
import {
  BROWSER_NAME_RE,
  COGPIT_SESSION_ID_RE,
  DEFAULT_BROWSER,
  OWNERS_DIR_NAME,
  SHARED_RUN_NAME,
  THROWAWAY_PREFIX,
  THROWAWAY_USED_SUFFIX,
  UNOWNED_FILE,
  binDir,
  nodeShimPath,
  shimPath,
} from "./paths"
import { writeIfChanged } from "./files"

export const SHIM_VERSION = 4

const BINARY_NAME = "agent-browser"
const NODE_SHIM_NAME = "agent-browser-shim.mjs"
const MARKER = `cogpit-shim v${SHIM_VERSION} — routes agent-browser into Cogpit's managed browser tree.`

/**
 * Chromium sets `navigator.webdriver` whenever a debugging port is open, and
 * bot checks such as Cloudflare's Turnstile refuse the page on that alone. A
 * user completing a human-verification step in the panel is not automation,
 * so a windowed browser runs with that signal off.
 */
const VISIBLE_BROWSER_ARGS = "--remote-debugging-port=0,--disable-blink-features=AutomationControlled"

export interface ShimOptions {
  /** A full Chrome or Chromium that can open a named browser in a real window on request; null keeps them headless. */
  visibleBrowser?: string | null
  /** Which host's shim to render; defaults to this process's platform. */
  platform?: NodeJS.Platform
}

/** Escapes a value for interpolation inside bash double quotes. */
function shellQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`)
}

/**
 * Named browsers stay headless unless the launching call sets
 * `COGPIT_BROWSER_HEADED`: a window on the user's desktop is only worth it when
 * a bot check refuses headless Chromium's user agent and a human has to pass
 * it. Even then a window needs a display, which macOS always has and Linux
 * only when the agent's environment names an X or Wayland one. Throwaways stay
 * headless: nobody watches them.
 */
function renderVisibleBrowser(visibleBrowser: string | null, platform: NodeJS.Platform): string {
  if (!visibleBrowser || (platform !== "darwin" && platform !== "linux")) return ""
  const conditions = [`[ -n "\${COGPIT_BROWSER_HEADED:-}" ]`]
  if (platform === "linux") conditions.push(`[ -n "\${DISPLAY:-}\${WAYLAND_DISPLAY:-}" ]`)
  return `if ${conditions.join(" && ")}; then
export AGENT_BROWSER_HEADED=1
export AGENT_BROWSER_EXECUTABLE_PATH="${shellQuoted(visibleBrowser)}"
export AGENT_BROWSER_ARGS="${VISIBLE_BROWSER_ARGS}"
fi
`
}

/**
 * agent-browser's daemon clears the socket it starts on, so two calls that
 * both find no daemon for a browser each start one, and the first is orphaned
 * with its Chromium. The call that starts a browser's daemon runs under a lock
 * beside its socket and waits for its command to finish; any call that meets
 * the lock waits, then joins the daemon it started. A lock whose holder died
 * is broken at once, and one held past its wait is broken too.
 */
const START_LOCK_SUFFIX = ".starting"
const START_WAIT_TICKS = 300
const START_TICK_S = 0.1

function renderSingleFlight(): string {
  return `daemon_up() {
  local pid
  pid="$(cat "$AGENT_BROWSER_SOCKET_DIR/$name.pid" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
run_browser() {
  daemon_up && exec "$real" "$@"
  lock="$AGENT_BROWSER_SOCKET_DIR/$name${START_LOCK_SUFFIX}"
  waited=0
  until mkdir "$lock" 2>/dev/null; do
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ "$waited" -ge ${START_WAIT_TICKS} ]; then
      rm -rf "$lock"
      waited=0
      continue
    fi
    sleep ${START_TICK_S}
    waited=$((waited + 1))
  done
  trap 'rm -rf "$lock"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "$$" > "$lock/pid"
  if daemon_up; then
    rm -rf "$lock"
    trap - EXIT HUP INT TERM
    exec "$real" "$@"
  fi
  status=0
  "$real" "$@" || status=$?
  exit "$status"
}
`
}

/**
 * An agent Cogpit spawned (it always sets `COGPIT_SESSION_ID`, if only to the
 * empty string) opens its session's own profile as `default` when the server
 * left a note naming one; see `server/browser/owners.ts`. The name is swapped
 * where the call spelled it and in the environment, so the daemon, its socket
 * and the profile all carry it. Cogpit's own launch and stop calls unset the
 * variable and reach the host's `default` itself, as does anything with no note.
 */
function renderOwnedDefault(): string {
  return `if [ "$name" = "${DEFAULT_BROWSER}" ] && [ -n "\${COGPIT_SESSION_ID+set}" ]; then
  note="$home/${OWNERS_DIR_NAME}/${UNOWNED_FILE}"
  if valid_sid "$COGPIT_SESSION_ID" && [ -f "$home/${OWNERS_DIR_NAME}/$COGPIT_SESSION_ID" ]; then
    note="$home/${OWNERS_DIR_NAME}/$COGPIT_SESSION_ID"
  fi
  owned=""
  if [ -f "$note" ]; then IFS= read -r owned < "$note" || true; fi
  if [ -n "$owned" ] && [ "$owned" != "${DEFAULT_BROWSER}" ] && [[ "$owned" != ${THROWAWAY_PREFIX}* ]] && valid_name "$owned"; then
    args=()
    swapped=""
    prev=""
    for arg in "$@"; do
      if [ -z "$swapped" ]; then
        if [ "$prev" = "--session" ]; then
          arg="$owned"; swapped=1
        else
          case "$arg" in --session=*) arg="--session=$owned"; swapped=1;; esac
        fi
      fi
      args+=("$arg")
      prev="$arg"
    done
    set -- \${args[@]+"\${args[@]}"}
    name="$owned"
    export AGENT_BROWSER_SESSION="$owned"
  fi
fi
`
}

export function renderShim(realBinary: string, options: ShimOptions = {}): string {
  const { visibleBrowser = null, platform = process.platform } = options
  return `#!/usr/bin/env bash
# ${MARKER}
# Regenerated by Cogpit on start; edits are lost.
set -euo pipefail
real="${shellQuoted(realBinary)}"
if [ ! -x "$real" ] || [ "$real" -ef "$0" ]; then
  echo "cogpit-shim: $real is not usable; restart Cogpit to refresh the shim" >&2
  exit 127
fi
valid_name() { local LC_ALL=C; [[ "$1" =~ ${BROWSER_NAME_RE.source} ]]; }
valid_sid()  { local LC_ALL=C; [[ "$1" =~ ${COGPIT_SESSION_ID_RE.source} ]]; }
${renderSingleFlight()}[ -n "\${COGPIT_BROWSER_HOME:-}" ] || [ -n "\${HOME:-}" ] || exec "$real" "$@"
home="\${COGPIT_BROWSER_HOME:-$HOME/.cogpit/browser}"
name="\${AGENT_BROWSER_SESSION:-${DEFAULT_BROWSER}}"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--session" ]; then name="$arg"; break; fi
  case "$arg" in --session=*) name="\${arg#--session=}"; break;; esac
  prev="$arg"
done
valid_name "$name" || exec "$real" "$@"
if [[ "$name" == ${THROWAWAY_PREFIX}* ]]; then
  sid="\${COGPIT_SESSION_ID:-}"
  valid_sid "$sid" || sid="${SHARED_RUN_NAME}"
  export AGENT_BROWSER_SOCKET_DIR="$home/run/$sid"
  mkdir -p "$AGENT_BROWSER_SOCKET_DIR"
  touch "$AGENT_BROWSER_SOCKET_DIR/$name${THROWAWAY_USED_SUFFIX}" 2>/dev/null || true
  run_browser "$@"
fi
${renderOwnedDefault()}profile="$home/profiles/$name"
mkdir -p "$profile" "$home/run/${SHARED_RUN_NAME}"
if [ -n "\${COGPIT_SESSION_ID+set}" ]; then printf '%s\\n' "$COGPIT_SESSION_ID" > "$profile/.driver"; fi
export AGENT_BROWSER_SOCKET_DIR="$home/run/${SHARED_RUN_NAME}"
export AGENT_BROWSER_PROFILE="$profile"
export AGENT_BROWSER_ARGS="--remote-debugging-port=0"
${renderVisibleBrowser(visibleBrowser, platform)}run_browser "$@"
`
}

/**
 * The bash shim's routing, for hosts without bash on the agent's path. A real
 * binary that is a batch file goes through cmd.exe with the same quoting as
 * `binaryResolver`, since `shell: true` would join the arguments unescaped.
 */
export function renderNodeShim(realBinary: string): string {
  return `// ${MARKER}
// Regenerated by Cogpit on start; edits are lost.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const real = ${JSON.stringify(realBinary)}
const NAME_RE = ${BROWSER_NAME_RE.toString()}
const SID_RE = ${COGPIT_SESSION_ID_RE.toString()}
const args = process.argv.slice(2)
const env = { ...process.env }

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}
function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}
if (!isFile(real) || sameFile(real, fileURLToPath(import.meta.url))) {
  console.error(\`cogpit-shim: \${real} is not usable; restart Cogpit to refresh the shim\`)
  process.exit(127)
}

function quoteArgument(arg) {
  return \`"\${arg.replace(/(\\\\*)"/g, '$1$1\\\\"').replace(/(\\\\*)$/, "$1$1")}"\`
}
function escapeForCmd(text) {
  return text.replace(/([()[\\]%!^"\`<>&|;, *?])/g, "^$1")
}
function runReal() {
  const batch = process.platform === "win32" && /\\.(cmd|bat)$/i.test(real)
  const result = batch
    ? spawnSync(env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", \`"\${[escapeForCmd(real), ...args.map((arg) => escapeForCmd(quoteArgument(arg)))].join(" ")}"\`], { env, stdio: "inherit", windowsVerbatimArguments: true })
    : spawnSync(real, args, { env, stdio: "inherit" })
  if (result.error) {
    console.error(\`cogpit-shim: \${result.error.message}\`)
    return 127
  }
  return result.status ?? 1
}
function run() {
  process.exit(runReal())
}
function readText(path) {
  try { return readFileSync(path, "utf8").trim() } catch { return "" }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === "EPERM" }
}
function daemonUp() {
  const pid = Number(readText(join(env.AGENT_BROWSER_SOCKET_DIR, \`\${name}.pid\`)))
  return pid > 0 && isAlive(pid)
}
// The bash shim's single-flight start, with the same lock beside the socket.
function runBrowser() {
  if (daemonUp()) run()
  const lock = join(env.AGENT_BROWSER_SOCKET_DIR, \`\${name}${START_LOCK_SUFFIX}\`)
  const tick = new Int32Array(new SharedArrayBuffer(4))
  for (let waited = 0; ; waited++) {
    try {
      mkdirSync(lock)
      break
    } catch {}
    const holder = Number(readText(join(lock, "pid")))
    if ((holder > 0 && !isAlive(holder)) || waited >= ${START_WAIT_TICKS}) {
      rmSync(lock, { recursive: true, force: true })
      waited = 0
      continue
    }
    Atomics.wait(tick, 0, 0, ${START_TICK_S * 1000})
  }
  let status
  try {
    writeFileSync(join(lock, "pid"), String(process.pid))
    status = daemonUp() ? null : runReal()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
  if (status === null) run()
  process.exit(status)
}

const homeDir = process.platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME
const home = env.COGPIT_BROWSER_HOME || (homeDir ? join(homeDir, ".cogpit", "browser") : null)
if (home === null) run()

let name = env.AGENT_BROWSER_SESSION || ${JSON.stringify(DEFAULT_BROWSER)}
// Where the call spelled the name, if it did.
let spelledAt = -1
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session") {
    if (i + 1 < args.length) {
      name = args[i + 1]
      spelledAt = i + 1
    }
    break
  }
  if (args[i].startsWith("--session=")) {
    name = args[i].slice("--session=".length)
    spelledAt = i
    break
  }
}
if (!NAME_RE.test(name)) run()

if (name.startsWith(${JSON.stringify(THROWAWAY_PREFIX)})) {
  const sid = SID_RE.test(env.COGPIT_SESSION_ID ?? "") ? env.COGPIT_SESSION_ID : ${JSON.stringify(SHARED_RUN_NAME)}
  env.AGENT_BROWSER_SOCKET_DIR = join(home, "run", sid)
  mkdirSync(env.AGENT_BROWSER_SOCKET_DIR, { recursive: true })
  try { writeFileSync(join(env.AGENT_BROWSER_SOCKET_DIR, \`\${name}${THROWAWAY_USED_SUFFIX}\`), "") } catch {}
  runBrowser()
}

if (name === ${JSON.stringify(DEFAULT_BROWSER)} && env.COGPIT_SESSION_ID !== undefined) {
  const owners = join(home, ${JSON.stringify(OWNERS_DIR_NAME)})
  const own = SID_RE.test(env.COGPIT_SESSION_ID) ? join(owners, env.COGPIT_SESSION_ID) : null
  const note = own !== null && isFile(own) ? own : join(owners, ${JSON.stringify(UNOWNED_FILE)})
  let owned = ""
  try { owned = readFileSync(note, "utf8").split(/\\r?\\n/)[0] } catch {}
  if (NAME_RE.test(owned) && owned !== ${JSON.stringify(DEFAULT_BROWSER)} && !owned.startsWith(${JSON.stringify(THROWAWAY_PREFIX)})) {
    if (spelledAt >= 0) args[spelledAt] = args[spelledAt].startsWith("--session=") ? \`--session=\${owned}\` : owned
    env.AGENT_BROWSER_SESSION = owned
    name = owned
  }
}

const profile = join(home, "profiles", name)
const sharedRun = join(home, "run", ${JSON.stringify(SHARED_RUN_NAME)})
mkdirSync(profile, { recursive: true })
mkdirSync(sharedRun, { recursive: true })
if (env.COGPIT_SESSION_ID !== undefined) writeFileSync(join(profile, ".driver"), \`\${env.COGPIT_SESSION_ID}\\n\`)
env.AGENT_BROWSER_SOCKET_DIR = sharedRun
env.AGENT_BROWSER_PROFILE = profile
env.AGENT_BROWSER_ARGS = "--remote-debugging-port=0"
runBrowser()
`
}

export function renderCmdLauncher(): string {
  return `@echo off\r\nnode "%~dp0${NODE_SHIM_NAME}" %*\r\n`
}

export function renderBashLauncher(): string {
  return `#!/usr/bin/env bash
# ${MARKER}
# Regenerated by Cogpit on start; edits are lost.
exec node "$(dirname "$0")/${NODE_SHIM_NAME}" "$@"
`
}

/** Every file the shim occupies on this host, with the script each one holds. */
function shimFiles(
  realBinary: string,
  options: ShimOptions,
  platform: NodeJS.Platform,
): Array<[path: string, script: string]> {
  if (platform !== "win32") return [[shimPath(platform), renderShim(realBinary, options)]]
  return [
    [nodeShimPath(), renderNodeShim(realBinary)],
    [shimPath(platform), renderCmdLauncher()],
    [join(binDir(), BINARY_NAME), renderBashLauncher()],
  ]
}

export function ensureShim(realBinary: string | null, options: ShimOptions = {}): { path: string | null } {
  const platform = options.platform ?? process.platform
  if (realBinary === null) {
    for (const [path] of shimFiles("", options, platform)) rmSync(path, { force: true })
    return { path: null }
  }
  for (const [path, script] of shimFiles(realBinary, options, platform)) writeIfChanged(path, script, 0o755)
  return { path: shimPath(platform) }
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

export interface FindRealOptions {
  platform?: NodeJS.Platform
  arch?: string
  /** Injected by tests; defaults to a real filesystem probe. */
  isFile?: (candidate: string) => boolean
}

/**
 * Windows has no execute bit, so launchability comes from the extension. npm's
 * `.cmd` shim just runs the native binary the package vendors next to it, and
 * that binary is what the Node shim spawns: a `.cmd` needs cmd.exe in between.
 */
function findRealOnWindows(dirs: string[], options: FindRealOptions): string | null {
  const isFile = options.isFile ?? isRegularFile
  const vendored = win32.join("node_modules", BINARY_NAME, "bin", `${BINARY_NAME}-win32-${options.arch ?? process.arch}.exe`)
  for (const dir of dirs) {
    const native = win32.join(dir, `${BINARY_NAME}.exe`)
    if (isFile(native)) return native
    const batch = win32.join(dir, `${BINARY_NAME}.cmd`)
    if (!isFile(batch)) continue
    const packaged = win32.join(dir, vendored)
    return isFile(packaged) ? packaged : batch
  }
  return null
}

export function findRealAgentBrowser(env: NodeJS.ProcessEnv = process.env, options: FindRealOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const path = platform === "win32" ? win32 : posix
  const shimDir = canonical(binDir())
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((entry) => entry && canonical(entry) !== shimDir)
  if (platform === "win32") return findRealOnWindows(dirs, options)
  const isFile = options.isFile ?? isExecutableFile
  for (const dir of dirs) {
    const candidate = path.join(dir, BINARY_NAME)
    if (isFile(candidate)) return candidate
  }
  return null
}

const MAC_BROWSER_APPS = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium"]
const LINUX_BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]

/**
 * A full Chrome or Chromium that can open a window. agent-browser's own download
 * is the headless shell, which cannot, so this is what a visible browser runs on.
 */
export function findVisibleBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  return visibleBrowserCandidates(env, platform).find(isExecutableFile) ?? null
}

/** Every place a visible browser may live, best first. */
function visibleBrowserCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    const roots = ["/Applications", ...(env.HOME ? [join(env.HOME, "Applications")] : [])]
    return MAC_BROWSER_APPS.flatMap((app) => roots.map((root) => join(root, app)))
  }
  if (platform !== "linux") return []
  const dirs = (env.PATH ?? "").split(posix.delimiter).filter(Boolean)
  return LINUX_BROWSER_NAMES.flatMap((name) => dirs.map((dir) => join(dir, name)))
}
