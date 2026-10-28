import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { editionModule } from "../edition"
import { slackService } from "../slack"
import { SlackLinkError } from "../slack/service"
import { json, parseArgs, UsageError, type CliInvocation, type CliOutput } from "./args"
import { CLI_NAME } from "./hints"

export const SLACK_USAGE = `  slack bot add NAME --env-file FILE | --bot-token-file FILE --app-token-file FILE
        Store a Slack app's bot (xoxb-) and app (xapp-) tokens on this machine.
        Tokens are read from files, never from the command line. --env-file
        reads SLACK_BOT_TOKEN and SLACK_APP_TOKEN from a dotenv file.
  slack bot remove NAME     Forget a bot (unlink it first).
  slack bots                Bots on this machine, without their tokens.
  slack link [ID] --bot NAME [--allow U1,U2] [--dm D1] [--channel C1,C2]
      [--auto-post on|off] [--daily-cap N]
        Deliver DMs, Assistant-thread messages, thread replies and mentions
        from allowlisted users (default: the owner) to session ID (default:
        you) over Socket Mode, as steering messages. It may post only to those
        users' DMs and the channels listed. --auto-post posts the turn's final
        answer into the thread it came from (default off); --daily-cap
        limits posts per UTC day (default 20).
  slack unlink [ID]         Stop listening; queued messages not yet delivered are dropped.
  slack status [ID]         Links, connection state, queued messages, posts today.
  slack reply [--thread TS] [--channel C] MESSAGE|-
        Post as your link's bot, in a thread (default: top level of the DM).
        Markdown becomes Slack mrkdwn. Same text to the same place within 30
        minutes is dropped.`

function dotenv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    let value = match[2]
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, "")
    values.set(match[1], value)
  }
  return values
}

async function readSecretFile(inv: CliInvocation, path: string): Promise<string> {
  try {
    return (await readFile(resolve(inv.cwd, path), "utf-8")).trim()
  } catch {
    throw new UsageError(`Cannot read ${path} on this machine`)
  }
}

function list(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(",").map((entry) => entry.trim()).filter(Boolean)
}

function requireLinkAdmin(inv: CliInvocation): void {
  if (!inv.admin) throw new Error("Only an admin can manage Slack bots and links")
  // Delivery runs without a signed-in request, which an edition with accounts does not allow.
  if (editionModule().auth) throw new Error("Slack links are not available on a Cogpit with accounts yet")
}

function targetSession(inv: CliInvocation, id: string | undefined, command: string): string {
  const sessionId = id ?? inv.callerSessionId
  if (!sessionId) throw new UsageError(`slack ${command} needs a session id outside a Cogpit session`)
  return sessionId
}

async function botCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const [verb, ...more] = rest
  const args = parseArgs(more, ["env-file", "bot-token-file", "app-token-file"], [])
  requireLinkAdmin(inv)
  const name = args.positionals[0]
  if (!name) throw new UsageError(`slack bot ${verb ?? "add"} needs a bot name`)
  if (verb === "remove") return json({ bot: name, removed: await slackService().removeBot(name) })
  if (verb !== "add") throw new UsageError("slack bot needs add or remove")
  let botToken: string | undefined
  let appToken: string | undefined
  const envFile = args.values.get("env-file")
  if (envFile) {
    const values = dotenv(await readSecretFile(inv, envFile))
    botToken = values.get("SLACK_BOT_TOKEN")
    appToken = values.get("SLACK_APP_TOKEN")
  }
  const botFile = args.values.get("bot-token-file")
  const appFile = args.values.get("app-token-file")
  if (botFile) botToken = await readSecretFile(inv, botFile)
  if (appFile) appToken = await readSecretFile(inv, appFile)
  if (!botToken || !appToken) throw new UsageError("slack bot add needs both tokens: --env-file, or --bot-token-file and --app-token-file")
  return json({ bot: await slackService().addBot(name, botToken, appToken) })
}

function onOff(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value !== "on" && value !== "off") throw new UsageError(`--${flag} takes on or off`)
  return value === "on"
}

function dailyCap(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cap = Number(value)
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) throw new UsageError("--daily-cap takes a whole number from 1 to 500")
  return cap
}

export async function slackCommand(inv: CliInvocation, rest: string[]): Promise<CliOutput> {
  const [verb, ...more] = rest
  try {
    switch (verb) {
      case "bot":
        return await botCommand(inv, more)
      case "bots":
        return json({ bots: await slackService().bots() })
      case "link": {
        const args = parseArgs(more, ["bot", "allow", "dm", "channel", "auto-post", "daily-cap"], [])
        requireLinkAdmin(inv)
        const bot = args.values.get("bot")
        if (!bot) throw new UsageError("slack link needs --bot NAME")
        const cap = dailyCap(args.values.get("daily-cap"))
        const link = await slackService().link({
          sessionId: targetSession(inv, args.positionals[0], "link"),
          bot,
          allow: list(args.values.get("allow")),
          dms: list(args.values.get("dm")),
          channels: list(args.values.get("channel")),
          autoPost: onOff(args.values.get("auto-post"), "auto-post"),
          dailyCap: cap,
        })
        return json({ link, next: `${CLI_NAME} slack status ${link.sessionId}` })
      }
      case "unlink": {
        const args = parseArgs(more, [], [])
        const sessionId = targetSession(inv, args.positionals[0], "unlink")
        if (sessionId !== inv.callerSessionId) requireLinkAdmin(inv)
        return json({ sessionId, ...(await slackService().unlink(sessionId)) })
      }
      case "status": {
        const args = parseArgs(more, [], [])
        return json(await slackService().status(args.positionals[0] ?? inv.callerSessionId))
      }
      case "reply": {
        const args = parseArgs(more, ["thread", "channel", "session"], [])
        const sessionId = args.values.get("session") ?? inv.callerSessionId
        if (!sessionId) throw new UsageError("slack reply posts as your session's link; run it from a Cogpit session or pass --session ID")
        if (sessionId !== inv.callerSessionId) requireLinkAdmin(inv)
        const text = args.positionals.join(" ").trim()
        if (!text) throw new UsageError("slack reply needs a message")
        return json(await slackService().reply(sessionId, { threadTs: args.values.get("thread"), channel: args.values.get("channel"), text }))
      }
      default:
        throw new UsageError("slack needs bot, bots, link, unlink, status or reply")
    }
  } catch (error) {
    if (error instanceof SlackLinkError) return { exitCode: 1, stdout: "", stderr: `${error.message}\n` }
    throw error
  }
}
