/**
 * Claude's account switcher: claude-swap's `cswap` CLI, which keeps several
 * Claude Code logins and swaps the live one. Cogpit only ever runs its JSON
 * commands and projects the answers onto the account contract — the
 * credentials, Keychain items and backups stay the switcher's business.
 */
import type {
  AccountSwitchResult,
  AccountUsage,
  AccountUsageWindow,
  AgentAccount,
  AgentAccountsReport,
} from "../../shared/contracts/agentAccounts"
import { extractVersion } from "../../shared/versions"
import { findExecutableOnPath } from "../lib/binaryResolver"
import { DEFAULT_PROBE_TIMEOUT_MS, runCli, type CliRunResult } from "../lib/cliProcess"

export const CSWAP_BIN = "cswap"
const TOOL_NAME = "claude-swap"

/** `list` refreshes every account's quota over the network before answering. */
const LIST_TIMEOUT_MS = 30_000
/** A switch backs up the live login, then restores another; both may hit the Keychain. */
const SWITCH_TIMEOUT_MS = 30_000

type Row = Record<string, unknown>

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function asSlot(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function parseWindow(value: unknown): AccountUsageWindow | null {
  const row = asRow(value)
  if (!row || typeof row.pct !== "number" || !Number.isFinite(row.pct)) return null
  return {
    pct: Math.min(100, Math.max(0, row.pct)),
    resetsIn: asString(row.countdown),
    resetsAt: asString(row.resetsAt),
  }
}

function parseUsage(value: unknown): AccountUsage | null {
  const row = asRow(value)
  if (!row) return null
  return { fiveHour: parseWindow(row.fiveHour), sevenDay: parseWindow(row.sevenDay) }
}

function parseAccount(value: unknown): AgentAccount | null {
  const row = asRow(value)
  if (!row) return null
  const slot = asSlot(row.number)
  const email = asString(row.email)
  if (slot === null || email === null) return null
  return {
    slot,
    alias: asString(row.alias),
    email,
    organization: asString(row.organizationName),
    active: row.active === true,
    disabled: row.disabled === true,
    usageStatus: asString(row.usageStatus) ?? "unavailable",
    usage: parseUsage(row.usage),
  }
}

function parseJson(stdout: string): Row | null {
  try {
    return asRow(JSON.parse(stdout))
  } catch {
    return null
  }
}

/** `cswap list --json` → accounts, or null when the output is not that schema. */
export function parseAccountList(stdout: string): Pick<Extract<AgentAccountsReport, { status: "ok" }>, "activeSlot" | "accounts"> | null {
  const payload = parseJson(stdout)
  if (!payload || !Array.isArray(payload.accounts)) return null
  return {
    activeSlot: asSlot(payload.activeAccountNumber),
    accounts: payload.accounts.map(parseAccount).filter((account): account is AgentAccount => account !== null),
  }
}

/** `cswap switch --json` → the outcome, the switcher's error, or null when unreadable. */
export function parseSwitchResult(
  stdout: string,
): Omit<AccountSwitchResult, "credentialStore"> | { error: string } | null {
  const payload = parseJson(stdout)
  if (!payload) return null
  const error = switcherError(payload)
  if (error) return { error }
  if (typeof payload.switched !== "boolean") return null
  return {
    switched: payload.switched,
    message: asString(payload.message) ?? (payload.switched ? "Switched account." : "Account unchanged."),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((w): w is string => typeof w === "string") : [],
  }
}

function switcherError(payload: Row): string | null {
  return asString(asRow(payload.error)?.message)
}

function failureMessage(run: CliRunResult, fallback: string): string {
  if (run.timedOut) return `${CSWAP_BIN} timed out`
  const envelope = parseJson(run.stdout)
  return (envelope && switcherError(envelope)) || run.stderr.trim() || fallback
}

export function isClaudeSwapInstalled(): boolean {
  return findExecutableOnPath(CSWAP_BIN) !== undefined
}

export async function describeClaudeAccounts(): Promise<AgentAccountsReport> {
  if (!isClaudeSwapInstalled()) return { status: "missing" }
  const [version, list] = await Promise.all([
    runCli(CSWAP_BIN, ["--version"], DEFAULT_PROBE_TIMEOUT_MS),
    runCli(CSWAP_BIN, ["list", "--json"], LIST_TIMEOUT_MS),
  ])
  if (list.code !== 0) {
    return { status: "error", error: failureMessage(list, `${CSWAP_BIN} list failed`) }
  }
  const parsed = parseAccountList(list.stdout)
  if (!parsed) return { status: "error", error: `${CSWAP_BIN} list returned unexpected output` }
  return { status: "ok", tool: TOOL_NAME, version: extractVersion(version.stdout), ...parsed }
}

export async function switchClaudeAccount(slot: number): Promise<AccountSwitchResult> {
  if (asSlot(slot) === null) throw new Error("slot must be a positive integer")
  const run = await runCli(CSWAP_BIN, ["switch", String(slot), "--json"], SWITCH_TIMEOUT_MS)
  const parsed = run.code === 0 ? parseSwitchResult(run.stdout) : null
  if (!parsed) throw new Error(failureMessage(run, `${CSWAP_BIN} switch failed`))
  if ("error" in parsed) throw new Error(parsed.error)
  return { ...parsed, credentialStore: process.platform === "darwin" ? "keychain" : "file" }
}
