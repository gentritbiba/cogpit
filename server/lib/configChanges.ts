import { isDeepStrictEqual } from "node:util"
import { parseExecutableChoice } from "../../shared/contracts/agentExecutable"
import type { AppConfig } from "../config"

/** The settings a client saves with its config, as a request body carries them. */
export interface ClientSettings {
  networkAccess?: unknown
  terminalApp?: string
  editorApp?: string
  useBuiltInEditor?: unknown
  agentExecutable?: unknown
}

type StoredSettings = Pick<AppConfig, "networkAccess" | "terminalApp" | "editorApp" | "useBuiltInEditor" | "agentExecutable">

/** A client's settings as the config stores them: flags as booleans, blanks and the automatic executable left out. */
export function storedSettings(settings: ClientSettings): StoredSettings {
  return {
    networkAccess: !!settings.networkAccess,
    terminalApp: settings.terminalApp || undefined,
    editorApp: settings.editorApp || undefined,
    useBuiltInEditor: !!settings.useBuiltInEditor,
    agentExecutable: parseExecutableChoice(settings.agentExecutable),
  }
}

/** The names of the settings saving `next` over `current` changes, never their values. */
export function changedConfigKeys(current: AppConfig | null, next: AppConfig): string[] {
  const before: Partial<AppConfig> = { ...current, ...storedSettings(current ?? {}) }
  return (Object.keys(next) as Array<keyof AppConfig>)
    .filter((key) => !isDeepStrictEqual(before[key], next[key]))
    .sort()
}
