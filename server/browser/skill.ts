/**
 * The skill that teaches agents how Cogpit's browser tree works, plus the two
 * ways it reaches them.
 *
 * The plugin is automatic: it is written inside Cogpit's own tree and handed to
 * the sessions Cogpit starts, so nothing outside `~/.cogpit` is touched. The
 * install is not. It copies the skill into an agent CLI's global config, which
 * is the user's own directory — often one they keep in version control — so it
 * happens only when the panel or the API asks for it, never at startup.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { BrowserSkillTarget } from "../../shared/browser/types"
import { AGENT_KINDS, descriptorFor } from "../../shared/session/agent-descriptors"
import type { AgentKind } from "../../shared/session/types"
import { pluginDir } from "./paths"

export const SKILL_NAME = "cogpit-browser"

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
  "Use the shared page for live demos, testing and fixing websites, research,",
  "and authorized work in signed-in accounts. The user can take over a step,",
  "then you can continue from the page they leave you. The panel and your tool",
  "can select different tabs. Name the browser and tab during a manual handoff,",
  "pause browser actions, wait for their confirmation, select that tab, and take",
  "a fresh snapshot before continuing. Website snapshots do not tell you whether the panel is",
  "open or what Cogpit's layout looks like.",
  "",
  "## The default browser",
  "",
  "No `--session` flag means the shared `default` browser. Its profile is",
  "persistent, so cookies and logins survive the command, the session and app",
  "restarts. Use it for anything that needs the user's own accounts.",
  "",
  "Never `close` the `default` browser out of tidiness. Leave it running: the user",
  "may still be using it, and the next task starts warm. Close it only when asked.",
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
  "In SDK sessions Cogpit redirects recognized subagent browser calls: a command",
  "aimed at `default` or a named browser is rewritten onto a `tmp-` browser before",
  "it runs, and you are told which one. A command Cogpit cannot rewrite safely —",
  "shell code passed to an interpreter, or arguments read from variables — is",
  "denied instead, for you to re-issue. Report the browser you were given, never",
  "the one you asked for. Ordinary mentions in commit messages or searches pass",
  "unchanged. Keep browser work in direct calls with literal arguments; calls",
  "hidden in scripts or other tools are outside this hook's coverage.",
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
  "4. Select the handoff tab, take a fresh snapshot, then continue.",
  "",
  "The profile keeps that login, so it costs the user one login per site per",
  "browser, not one per task.",
  "",
  "## The panel sets the page size",
  "",
  "Opening or resizing the Browser panel sets the page's viewport to the panel's",
  "aspect ratio, at least 1024 CSS pixels wide. Screenshots can change the viewport;",
  "the panel then fits the new dimensions without cropping the page.",
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

/** The plugin Cogpit writes is shaped for whichever CLI reads plugins from a path. */
function pluginManifestDirName(): string | null {
  for (const kind of AGENT_KINDS) {
    const { pluginManifestDir } = descriptorFor(kind).config
    if (pluginManifestDir !== null) return pluginManifestDir
  }
  return null
}

/** Null when no CLI takes a plugin, in which case only the skill install reaches agents. */
export function pluginManifestFile(): string | null {
  const dir = pluginManifestDirName()
  return dir === null ? null : join(pluginDir(), dir, "plugin.json")
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
export function ensurePlugin(): string | null {
  const manifest = pluginManifestFile()
  if (manifest === null) return null
  writeIfChanged(manifest, `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`)
  writeIfChanged(pluginSkillFile(), COGPIT_BROWSER_SKILL)
  return pluginDir()
}

function skillHome(): string {
  return process.env.COGPIT_SKILL_HOME || homedir()
}

function configRoot(kind: AgentKind): string {
  return join(skillHome(), descriptorFor(kind).config.rootDirName)
}

function skillDir(kind: AgentKind): string | null {
  const { skillsDir } = descriptorFor(kind).config
  return skillsDir === null ? null : join(configRoot(kind), skillsDir, SKILL_NAME)
}

/** Copies the skill into a CLI's global config, for agents Cogpit does not spawn. */
export function installSkill(target: AgentKind): string {
  const dir = skillDir(target)
  if (dir === null) throw new Error(`${descriptorFor(target).displayName} has no skills directory`)
  writeIfChanged(join(dir, "SKILL.md"), COGPIT_BROWSER_SKILL)
  return dir
}

/**
 * What the panel lists: every CLI that reads skills, with the directory an
 * install would write into and whether the skill is already there.
 */
export function skillTargets(): BrowserSkillTarget[] {
  const pluginDirName = pluginManifestDirName()
  return AGENT_KINDS.flatMap((kind) => {
    const dir = skillDir(kind)
    if (dir === null) return []
    const { config, displayName } = descriptorFor(kind)
    return [{
      kind,
      label: displayName,
      configRoot: configRoot(kind),
      installed: hasContent(join(dir, "SKILL.md"), COGPIT_BROWSER_SKILL),
      automatic: config.pluginManifestDir !== null && config.pluginManifestDir === pluginDirName,
    }]
  })
}

/**
 * Installs for every CLI at once, for the user who asks for all of them.
 *
 * Skips a CLI whose config root is absent rather than creating one the user
 * never asked for, and one CLI failing never costs the rest theirs.
 */
export function installSkillEverywhere(): string[] {
  const installed: string[] = []
  const failures: string[] = []
  for (const kind of AGENT_KINDS) {
    const dir = skillDir(kind)
    if (dir === null || !existsSync(configRoot(kind))) continue
    try {
      writeIfChanged(join(dir, "SKILL.md"), COGPIT_BROWSER_SKILL)
      installed.push(dir)
    } catch (error) {
      failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`The browser skill did not reach ${failures.join("; ")}`)
  return installed
}
