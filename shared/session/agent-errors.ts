export function presentTurnError(error: string): string {
  const message = error.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("[ede_diagnostic]")).join("\n").trim()
  return message || "The agent stopped before completing this turn. You can continue the conversation."
}
