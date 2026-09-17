import type { SlashSuggestion } from "../../shared/contracts/projectTools"

function builtin(
  name: string,
  type: "command" | "skill",
  description: string,
): SlashSuggestion {
  return { name, description, type, source: "built-in", filePath: "" }
}

// Verified with supportedCommands() on Claude Code 2.1.270, 2026-09-14.
export const BUILTIN_SKILLS: SlashSuggestion[] = [
  builtin("output-style", "command", "List output styles or switch to one"),
  builtin("advisor", "command", "Let Claude consult a stronger model at key moments"),
  builtin("reload-plugins", "command", "Activate pending plugin changes in this session"),
  builtin("reload-skills", "command", "Reload skills added or changed on disk"),
  builtin("skill-doctor", "command", "Show unused skills and their context cost"),
  builtin("workflow-authoring", "skill", "Reference for writing Workflow scripts"),
  builtin("batch", "skill", "Plan a large change; background agents each open a PR"),
  builtin("claude-api", "skill", "Build and debug apps that use the Claude API"),
  builtin("code-review", "skill", "Review the current diff or a PR for bugs and cleanups"),
  builtin("dataviz", "skill", "Chart and dashboard design guidance"),
  builtin("debug", "skill", "Turn on debug logging and investigate problems"),
  builtin("design-sync", "skill", "Push your design system components to claude.ai/design"),
  builtin("fewer-permission-prompts", "skill", "Pre-approve safe read-only commands based on your usage"),
  builtin("loop", "skill", "Repeat a prompt or command on an interval (e.g. /loop 5m /foo)"),
  builtin("run", "skill", "Launch this project's app to see your change working"),
  builtin("run-skill-generator", "skill", "Create a skill that knows how to run this project's app"),
  builtin("simplify", "skill", "Clean up the changed code without changing behavior"),
  builtin("verify", "skill", "Build and run your app to confirm a code change does what it should"),
  builtin("compact", "command", "Free up context by summarizing the conversation so far"),
  builtin("init", "command", "Initialize a new CLAUDE.md file with codebase documentation"),
  builtin("schedule", "command", "Create and manage scheduled remote Claude Code agents"),
  builtin("security-review", "command", "Complete a security review of the pending changes on the current branch"),
  builtin("update-config", "command", "Change settings: hooks, permissions, environment variables"),
]
