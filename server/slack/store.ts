import { mkdir, readFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { serialQueue } from "../lib/serialQueue"
import type { SlackBot, SlackBotSummary, SlackState } from "./types"

/** `~/.cogpit/slack`, owner-only: `bots.json` holds the tokens, `state.json` the links and queue. */
export function slackDir(): string {
  return process.env.COGPIT_SLACK_DIR || join(homedir(), ".cogpit", "slack")
}

const KEEP_ADMITTED_MS = 7 * 24 * 3600_000
const KEEP_SENT_MS = 2 * 24 * 3600_000
const KEEP_THREADS_MS = 30 * 24 * 3600_000

const emptyState = (): SlackState => ({ version: 1, links: {}, inbox: [], threads: {}, sent: [] })

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf-8")
    await chmod(path, 0o600)
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function botsFrom(value: unknown): Map<string, SlackBot> {
  const bots = new Map<string, SlackBot>()
  const list = (value as { bots?: unknown } | undefined)?.bots
  if (!Array.isArray(list)) return bots
  for (const entry of list as SlackBot[]) {
    if (typeof entry?.name === "string" && typeof entry.botToken === "string" && typeof entry.appToken === "string") bots.set(entry.name, entry)
  }
  return bots
}

function stateFrom(value: unknown): SlackState {
  const parsed = value as Partial<SlackState> | undefined
  if (parsed?.version !== 1) return emptyState()
  return {
    version: 1,
    links: parsed.links ?? {},
    inbox: parsed.inbox ?? [],
    threads: parsed.threads ?? {},
    sent: parsed.sent ?? [],
  }
}

/** Drop what no longer matters: delivered messages, old posts and threads gone quiet. */
function prune(state: SlackState, now = Date.now()): void {
  state.inbox = state.inbox.filter((message) => message.status === "pending" || message.awaitingTurn || now - message.receivedAt < KEEP_ADMITTED_MS)
  state.sent = state.sent.filter((record) => now - record.at < KEEP_SENT_MS)
  for (const [key, thread] of Object.entries(state.threads)) if (now - thread.lastSeen > KEEP_THREADS_MS) delete state.threads[key]
}

export const summarizeBot = ({ botToken: _bot, appToken: _app, ...summary }: SlackBot): SlackBotSummary => summary

/**
 * The Slack files, loaded once and written through one chain. Every write is
 * durable: an inbound message is only acknowledged to Slack after it is on disk.
 */
export class SlackStore {
  private bots: Map<string, SlackBot> | null = null
  private state: SlackState | null = null
  private readonly queue = serialQueue()

  constructor(private readonly dir: string = slackDir()) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
  }

  async listBots(): Promise<SlackBot[]> {
    return [...(await this.botMap()).values()]
  }

  async bot(name: string): Promise<SlackBot | undefined> {
    return (await this.listBots()).find((bot) => bot.name === name)
  }

  saveBot(bot: SlackBot): Promise<void> {
    return this.queue.run(async () => {
      await this.writeBots(new Map(await this.botMap()).set(bot.name, bot))
    })
  }

  removeBot(name: string): Promise<boolean> {
    return this.queue.run(async () => {
      const next = new Map(await this.botMap())
      if (!next.delete(name)) return false
      await this.writeBots(next)
      return true
    })
  }

  private async botMap(): Promise<Map<string, SlackBot>> {
    this.bots ??= botsFrom(await readJson(join(this.dir, "bots.json")))
    return this.bots
  }

  /** Memory takes the new value only once it is on disk, so a failed write changes nothing. */
  private async writeBots(next: Map<string, SlackBot>): Promise<void> {
    await this.ensureDir()
    await writeOwnerOnlyJson(join(this.dir, "bots.json"), { version: 1, bots: [...next.values()] }, 0o600, { durable: true })
    this.bots = next
  }

  async read(): Promise<SlackState> {
    this.state ??= stateFrom(await readJson(join(this.dir, "state.json")))
    return this.state
  }

  /**
   * Apply `change` to a copy and write it before resolving. Memory takes the
   * copy only once it is on disk, so a failed write leaves both unchanged and
   * Slack's resend of the event is handled as new.
   */
  update<T>(change: (state: SlackState) => T): Promise<T> {
    return this.queue.run(async () => {
      const next = structuredClone(await this.read())
      const result = change(next)
      prune(next)
      await this.ensureDir()
      await writeOwnerOnlyJson(join(this.dir, "state.json"), next, 0o600, { durable: true })
      this.state = next
      return result
    })
  }
}
