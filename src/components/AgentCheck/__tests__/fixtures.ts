import type { AgentCheck } from "../../../../shared/contracts/agentCheck"

/** One agent's check result; installed and signed in unless overridden. */
export function agentCheck(overrides: Partial<AgentCheck> = {}): AgentCheck {
  return {
    kind: "claude",
    displayName: "Claude Code",
    binary: { path: "/usr/local/bin/claude", source: "path" },
    version: "2.1.318",
    signedIn: true,
    install: { page: "https://code.claude.com/docs/en/setup", command: "curl -fsSL https://claude.ai/install.sh | bash" },
    signIn: { executable: "/usr/local/bin/claude", args: ["auth", "login"], command: "claude auth login" },
    ...overrides,
  }
}

export const MISSING_CODEX = agentCheck({
  kind: "codex",
  displayName: "Codex",
  binary: null,
  version: null,
  signedIn: "unknown",
  install: { page: "https://developers.openai.com/codex/cli", command: "npm install -g @openai/codex" },
  signIn: null,
})

export const MISSING_COPILOT = agentCheck({
  kind: "copilot",
  displayName: "GitHub Copilot CLI",
  binary: null,
  version: null,
  signedIn: "unknown",
  install: { page: "https://docs.github.com/copilot", command: "curl -fsSL https://gh.io/copilot-install | bash" },
  signIn: null,
})

/** Only the copy that ships with Cogpit, never signed in. */
export const BUNDLED_SIGNED_OUT = agentCheck({
  binary: { path: "/app/node_modules/sdk/claude", source: "bundled" },
  version: "2.1.306",
  signedIn: false,
  signIn: { executable: "/app/node_modules/sdk/claude", args: ["auth", "login"], command: "/app/node_modules/sdk/claude auth login" },
})

export const MISSING_CLAUDE = agentCheck({ binary: null, version: null, signedIn: "unknown", signIn: null })
