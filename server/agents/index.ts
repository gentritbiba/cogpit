import {
  AGENT_KINDS,
  descriptorForDirName,
  type AgentKind,
} from "../../shared/session/agent-descriptors"
import { claudeStore } from "./claudeStore"
import { codexStore } from "./codexStore"
import { copilotStore } from "./copilotStore"
import type { AgentStore } from "./types"

/**
 * The server-side agent registry: one `AgentStore` per CLI, plus the resolvers
 * that pick one from a path, a dirName or a kind.
 *
 * A plain frozen table read through functions — the same shape as the format
 * registry in `shared/session/agents.ts`. Stores must never import this module
 * back: `scripts/check-architecture.ts` counts a type-only import as a real
 * graph edge and runs a Tarjan cycle check.
 */

export type { AgentStore, SessionFileInfo } from "./types"

const STORES: Readonly<Record<AgentKind, AgentStore>> = Object.freeze({
  claude: claudeStore,
  codex: codexStore,
  copilot: copilotStore,
})

export interface StoreRegistry {
  storeFor(kind: AgentKind): AgentStore
  storeForPath(filePath: string | null | undefined): AgentStore | null
  storeForDirName(dirName: string | null | undefined): AgentStore
  allStores(): readonly AgentStore[]
}

/**
 * Build resolvers over an arbitrary store table. The module-level singletons
 * below are this applied to the real table; tests inject a fake one.
 */
export function createStoreRegistry(
  stores: Readonly<Record<AgentKind, AgentStore>>,
): StoreRegistry {
  return {
    storeFor: (kind) => stores[kind],
    storeForPath(filePath) {
      if (typeof filePath !== "string") return null
      for (const kind of AGENT_KINDS) {
        if (stores[kind].ownsPath(filePath)) return stores[kind]
      }
      return null
    },
    storeForDirName: (dirName) => stores[descriptorForDirName(dirName).kind],
    allStores: () => AGENT_KINDS.map((kind) => stores[kind]),
  }
}

const registry = createStoreRegistry(STORES)

export function storeFor(kind: AgentKind): AgentStore {
  return registry.storeFor(kind)
}

/** The store whose storage contains `filePath`, or null when none does. */
export function storeForPath(filePath: string | null | undefined): AgentStore | null {
  return registry.storeForPath(filePath)
}

/** The store owning a project dirName. Claude is the terminal arm. */
export function storeForDirName(dirName: string | null | undefined): AgentStore {
  return registry.storeForDirName(dirName)
}

/** Every store, in agent-detection order. */
export function allStores(): readonly AgentStore[] {
  return registry.allStores()
}
