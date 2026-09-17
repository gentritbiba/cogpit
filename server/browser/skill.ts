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
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { hasContent, writeIfChanged } from "./files"
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
  "description: Browser automation inside Cogpit, where the user can watch the page live and drive it in the Browser panel. Use for any agent-browser work — opening sites, filling forms, scraping, testing a web app — and whenever the user should see what the browser is doing, a login has to persist, a task needs its own named browser, a subagent needs to browse, or a bot check such as Cloudflare's blocks the page.",
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
  "may still be using it, and the next task starts warm. Close it only when asked,",
  "or to switch it between headless and a window (see below).",
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
  "`--session` is yours; the rest of persistence is not. A window, when one is",
  "warranted, is asked for with `COGPIT_BROWSER_HEADED=1` (next section), never",
  "with `--headed`.",
  "",
  "## Headless by default, a window only for a bot check",
  "",
  "Every browser runs headless. Nothing appears on the user's screen; the Browser",
  "panel is how they watch. Do not open a Chrome window for a demo, for",
  "convenience, or because a page looks wrong.",
  "",
  "The one exception is a bot check that headless Chromium cannot pass: a",
  "Cloudflare \"Verify you are human\" or \"Checking your browser\" page, a Turnstile",
  "widget that fails as it loads, an hCaptcha or reCAPTCHA, or a Cloudflare block",
  "page (\"Sorry, you have been blocked\"). Headless Chromium's user agent says",
  "`HeadlessChrome` and the challenge refuses it outright, so waiting, retrying,",
  "or clicking the checkbox loops forever. Then, and only then:",
  "",
  "1. Close that browser: `agent-browser --session <name> close` (omit `--session`",
  "   for `default`). Closing it is right here: a browser is headless or windowed",
  "   from launch, and a running one ignores the variable, so it has to relaunch.",
  "2. Relaunch it with a window: `COGPIT_BROWSER_HEADED=1 agent-browser --session <name> open <url>`.",
  "   The profile and its logins carry over.",
  "3. Tell the user a Chrome window has opened on their desktop for the",
  "   challenge, and ask them to pass it there or in the Browser panel.",
  "4. Wait for their confirmation, take a fresh snapshot, and continue in the same",
  "   browser. Keep the window for the rest of the task: the site keeps checking",
  "   the user agent, so headless is refused again.",
  "5. When the task is done, say so and close that browser so the next task starts",
  "   headless.",
  "",
  "The variable is only honoured on the call that launches the browser; on a",
  "later command it does nothing. It has no effect on `tmp-` browsers, on a",
  "machine without a full Chrome or Chromium, or on Linux without a display: those",
  "stay headless, and the bot check cannot be passed there. A subagent that hits",
  "one stops, closes its `tmp-` browser, and reports the block to its parent, since",
  "only the main agent can relaunch a browser the user can reach.",
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
  "## Marking up screenshots",
  "",
  "To make a point about a page, such as this button or that broken layout, draw on",
  "the page and then screenshot it. The built-ins do not single anything out:",
  "`screenshot --annotate` numbers every interactive element, and `highlight <sel>`",
  "tints every match.",
  "",
  "Inject an SVG overlay instead. Edit `marks`, then pipe the script in with a",
  "heredoc (add `--session` as usual):",
  "",
  "- `shape`: `box`, `circle` or `arrow`",
  "- `selector`: a CSS selector; the first match is used",
  "- `text`: optional; picks the match whose trimmed text equals it, such as the name",
  "  a snapshot shows for an `@e` ref",
  "- `label`: the callout drawn beside the shape",
  "",
  "```bash",
  "cat <<'EOF' | agent-browser eval --stdin",
  "(() => {",
  "  const marks = [",
  "    { shape: 'box', selector: 'h1', label: 'Wrong heading' },",
  "    { shape: 'circle', selector: 'button', text: 'Sign up', label: 'Too small on mobile' },",
  "    { shape: 'arrow', selector: 'a', text: 'Pricing', label: 'Broken link' },",
  "  ];",
  "",
  "  const NS = 'http://www.w3.org/2000/svg', RED = '#ff2d55';",
  "  window.__markup?.observer.disconnect();",
  "  window.__markup?.svg.remove();",
  "  const svg = document.createElementNS(NS, 'svg');",
  "  Object.assign(svg.style, { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 2147483647, filter: 'drop-shadow(0 0 1.5px #fff)' });",
  "  document.body.appendChild(svg);",
  "",
  "  const add = (name, attrs, parent = svg) => {",
  "    const node = document.createElementNS(NS, name);",
  "    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);",
  "    return parent.appendChild(node);",
  "  };",
  "  const find = ({ selector, text }) => text",
  "    ? [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === text)",
  "    : document.querySelector(selector);",
  "  const callout = (x, y, text, anchor = 'start') => {",
  "    const t = add('text', { x, y, 'text-anchor': anchor, fill: '#fff', 'font-size': 14, 'font-weight': 700, 'font-family': 'system-ui' });",
  "    t.textContent = text;",
  "    const b = t.getBBox();",
  "    t.setAttribute('x', x + Math.max(scrollX + 8 - b.x, 0) - Math.max(b.x + b.width + 8 - scrollX - innerWidth, 0));",
  "    const c = t.getBBox();",
  "    svg.insertBefore(add('rect', { x: c.x - 6, y: c.y - 3, width: c.width + 12, height: c.height + 6, rx: 4, fill: RED }), t);",
  "  };",
  "",
  "  const shapes = {",
  "    box(r, label) {",
  "      add('rect', { x: r.x - 6, y: r.y - 4, width: r.w + 12, height: r.h + 8, rx: 4, fill: 'rgba(255,45,85,.12)', stroke: RED, 'stroke-width': 3 });",
  "      callout(r.x + r.w + 16, r.y + r.h / 2 + 5, label);",
  "    },",
  "    circle(r, label) {",
  "      add('ellipse', { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2 + 14, ry: r.h / 2 + 10, fill: 'none', stroke: RED, 'stroke-width': 3 });",
  "      callout(r.x + r.w / 2, r.y + r.h + 32, label, 'middle');",
  "    },",
  "    arrow(r, label) {",
  "      const fromLeft = r.x + r.w + 240 > scrollX + innerWidth;",
  "      const y = r.y + r.h / 2, tip = fromLeft ? r.x - 6 : r.x + r.w + 6, tail = fromLeft ? tip - 110 : tip + 110;",
  "      add('line', { x1: tail, y1: y, x2: tip, y2: y, stroke: RED, 'stroke-width': 3, 'marker-end': 'url(#markup-head)' });",
  "      callout(fromLeft ? tail - 10 : tail + 10, y + 5, label, fromLeft ? 'end' : 'start');",
  "    },",
  "  };",
  "",
  "  const render = () => {",
  "    svg.style.width = document.documentElement.scrollWidth + 'px';",
  "    svg.style.height = document.documentElement.scrollHeight + 'px';",
  "    svg.replaceChildren();",
  "    const head = add('marker', { id: 'markup-head', markerUnits: 'userSpaceOnUse', markerWidth: 14, markerHeight: 14, refX: 12, refY: 7, orient: 'auto' });",
  "    add('path', { d: 'M0,0 L14,7 L0,14 z', fill: RED }, head);",
  "    const missing = [];",
  "    for (const mark of marks) {",
  "      const el = find(mark);",
  "      if (!el) { missing.push(mark.label); continue; }",
  "      const b = el.getBoundingClientRect();",
  "      shapes[mark.shape]({ x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }, mark.label);",
  "    }",
  "    return missing;",
  "  };",
  "",
  "  const missing = render();",
  "  const observer = new ResizeObserver(render);",
  "  observer.observe(document.documentElement);",
  "  window.__markup = { svg, observer };",
  "  return missing.length ? 'not found: ' + missing.join(', ') : 'ok';",
  "})()",
  "EOF",
  "agent-browser screenshot /tmp/markup.png",
  "```",
  "",
  "It returns `ok`, or the labels whose element was not found. Shapes sit in page",
  "coordinates and redraw whenever the layout resizes, so the panel changing the",
  "viewport does not leave them pointing at the wrong spot. An arrow with no room",
  "to the right of its element points in from the left. Scroll the marked elements",
  "into view first, or capture with `screenshot --full`.",
  "",
  "Show the image with `![alt](/tmp/markup.png)` in your reply. The overlay is on",
  "the user's live page, so remove it once captured:",
  "",
  "```bash",
  "agent-browser eval 'window.__markup?.observer.disconnect(); window.__markup?.svg.remove()'",
  "```",
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
