/**
 * The copy of an agent CLI that ships inside Cogpit's own dependencies.
 *
 * Only Claude Code has one: the Agent SDK vendors it in a platform package.
 * Development builds and the npm launcher install that package; the packaged
 * desktop app leaves it out. This module reads no configuration, so config
 * bootstrap can ask about the bundled copy while it is still building one.
 */
import { createRequire } from "node:module"

import { descriptorFor } from "../../shared/session/agent-descriptors"
import type { AgentKind } from "../../shared/session/types"
import { nativeBinaryName } from "../lib/binaryResolver"

export const resolveModule = (id: string) => createRequire(import.meta.url).resolve(id)

export function findBundledClaude(resolve: (id: string) => string): string | undefined {
  try {
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    return resolve(`${platformPkg}/package.json`).replace(/package\.json$/, nativeBinaryName("claude"))
  } catch {
    return undefined
  }
}

/** The bundled binary for `kind`, when this build carries one. */
export function bundledExecutable(kind: AgentKind): string | undefined {
  return descriptorFor(kind).cli.bundledBySdk ? findBundledClaude(resolveModule) : undefined
}
