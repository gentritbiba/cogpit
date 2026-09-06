/**
 * The skill that teaches agents how Cogpit's browser tree works, plus the two
 * ways it reaches them: a local plugin every managed session loads, and an
 * explicit install for agents that run outside Cogpit.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import type { AgentKind } from "../../shared/session/types"
import { pluginDir } from "./paths"

export const SKILL_NAME = "cogpit-browser"

const MANIFEST_DIR = ".claude-plugin"

export const PLUGIN_MANIFEST = {
  name: "cogpit",
  version: "1",
  description: "Cogpit's built-in skills for the agents it runs.",
}

export const COGPIT_BROWSER_SKILL = [
  "---",
  `name: ${SKILL_NAME}`,
  "description: Browser automation inside Cogpit, where the user can watch the page live and drive it in the Browser panel. Use for any agent-browser work — opening sites, filling forms, scraping, testing a web app — and whenever the user should see what the browser is doing, a login has to persist, a task needs its own named browser, or a subagent needs to browse.",
  "---",
  "",
  "# Browser work inside Cogpit",
  "",
  "## What this is",
  "",
  "`agent-browser` works exactly as its own skill documents — same commands, same",
  "`@e1` refs, same chaining. Cogpit adds one thing: a **Browser** panel in the",
  "workspace that streams the live page and lets the user click, type and navigate",
  "in it while you work.",
  "",
  "Tell the user when you start browser work so they can open the panel.",
  "",
  "## The default browser",
  "",
  "No `--session` flag means the shared `default` browser. Its profile is",
  "persistent, so cookies and logins survive the command, the session and app",
  "restarts. Use it for anything that needs the user's own accounts.",
  "",
  "Never `close` the `default` browser out of tidiness. Leave it running: the user",
  "is watching it, and the next task starts warm. Close it only when asked.",
  "",
  "## Named browsers",
  "",
  "Use `--session <name>` for isolated, long-lived work — a second login, a",
  "long-running app, anything you do not want mixed into `default`.",
  "",
  "- Names match `^[a-z0-9][a-z0-9_-]{0,39}$`.",
  "- Creating one is implicit: the first command with a new name makes it, with its",
  "  own persistent profile.",
  "- Named browsers are global. Any Cogpit session's panel can show one, and the",
  "  panel says who drove it last.",
  "",
  "```bash",
  "agent-browser --session github open https://github.com/notifications",
  "agent-browser --session github snapshot -i",
  "```",
  "",
  "List them and read their notes over Cogpit's HTTP API. The packaged app binds an",
  "ephemeral port unless network access pins 19384, so resolve the port in this",
  "order:",
  "",
  "```bash",
  "PORT=\"${COGPIT_PORT:-$(cat ~/.cogpit/port 2>/dev/null || echo 19384)}\"",
  "BASE=\"http://localhost:$PORT\"",
  "",
  "curl -s \"$BASE/api/browser\"",
  "# → { installed, binaryPath, sessions: [{ name, running, note, lastUrl, ... }] }",
  "```",
  "",
  "Leave a note on a browser so the next agent — and the user — knows what it is",
  "for:",
  "",
  "```bash",
  "curl -s -X PATCH \"$BASE/api/browser/sessions/github\" \\",
  "  -H \"Content-Type: application/json\" \\",
  "  -d '{\"note\": \"Signed in as the release bot\"}'",
  "```",
  "",
  "`~/.cogpit/port` is written on server start and removed on exit. Local requests",
  "skip authentication.",
  "",
  "## Subagents use throwaway browsers",
  "",
  "**If you are a subagent, you MUST use `--session tmp-<something-unique>`, and run",
  "`agent-browser --session tmp-<that same name> close` when you finish.**",
  "",
  "Never touch `default` or a named browser from a subagent. Those are the user's",
  "visible browsers. Two agents on one browser share one page: your `open` throws",
  "away the other agent's page, its `@e1` refs go stale mid-task, and neither of you",
  "can see why the other's work broke. A `tmp-` browser is private, never appears in",
  "the panel, and is reaped when the session ends, so nothing you do there can",
  "corrupt work you cannot see.",
  "",
  "```bash",
  "agent-browser --session tmp-a3f9 open https://example.com",
  "agent-browser --session tmp-a3f9 snapshot -i",
  "agent-browser --session tmp-a3f9 close",
  "```",
  "",
  "## Flags Cogpit owns",
  "",
  "Never pass `--profile`, `--state`, `--session-name`, `--args`, `--headed` or",
  "`--cdp`. Cogpit sets these to give each browser its persistent profile and the",
  "debugging port the panel attaches to. Overriding one detaches the browser from",
  "the panel and can lose the user's logins.",
  "",
  "`--session` is yours; the rest of persistence is not.",
  "",
  "## When the site needs a login",
  "",
  "Do not attempt to type the user's credentials, and do not go looking for them.",
  "Instead:",
  "",
  "1. Say which browser you are using.",
  "2. Ask the user to log in inside the Browser panel.",
  "3. Wait for them to confirm.",
  "4. Continue.",
  "",
  "The profile keeps that login, so it costs the user one login per site per",
  "browser, not one per task.",
  "",
  "## The panel sets the page size",
  "",
  "While the user has the Browser panel open, the page's viewport follows the",
  "panel — at least 1024 CSS pixels wide, never a mobile layout. So",
  "`window.innerWidth`, media queries and the size of a non-fullPage screenshot",
  "reflect the panel rather than the usual 1280×720.",
  "",
  "If something you assert on needs a fixed size, set it yourself with",
  "`agent-browser set viewport <w> <h>`. The panel then letterboxes the page until",
  "it is resized again.",
  "",
  "## Telling the user what you are doing",
  "",
  "When you start browser work, name the browser in one line:",
  "",
  "> Working in the `default` browser — open the Browser panel to watch.",
  "",
  "Repeat it whenever you switch browsers. The user cannot follow along unless they",
  "know which browser to open.",
  "",
].join("\n")

export function pluginManifestFile(): string {
  return join(pluginDir(), MANIFEST_DIR, "plugin.json")
}

export function pluginSkillFile(): string {
  return join(pluginDir(), "skills", SKILL_NAME, "SKILL.md")
}

function hasContent(path: string, content: string): boolean {
  try {
    return readFileSync(path, "utf8") === content
  } catch {
    return false
  }
}

function writeIfChanged(path: string, content: string): void {
  if (hasContent(path, content)) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** Materialises the plugin agents load from disk. Idempotent. */
export function ensurePlugin(): string {
  writeIfChanged(pluginManifestFile(), `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`)
  writeIfChanged(pluginSkillFile(), COGPIT_BROWSER_SKILL)
  return pluginDir()
}

function skillHome(): string {
  return process.env.COGPIT_SKILL_HOME || homedir()
}

/** Copies the skill into a CLI's global config, for agents Cogpit does not spawn. */
export function installSkill(target: AgentKind): string {
  const { rootDirName, skillsDir } = descriptorFor(target).config
  if (!skillsDir) throw new Error(`${descriptorFor(target).displayName} has no skills directory`)
  const dir = join(skillHome(), rootDirName, skillsDir, SKILL_NAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), COGPIT_BROWSER_SKILL)
  return dir
}
