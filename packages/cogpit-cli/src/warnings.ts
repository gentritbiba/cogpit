type EmitWarning = NodeJS.Process["emitWarning"]

/**
 * Drop Node's "SQLite is an experimental feature" warning, which reads like an
 * error to someone who just ran `npx cogpit`. Every other warning still prints.
 */
export function quietSqliteWarning(target: { emitWarning: EmitWarning }): void {
  const emitWarning = target.emitWarning.bind(target) as (...args: unknown[]) => void
  target.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const option = rest[0]
    const type = typeof option === "string" ? option : (option as { type?: unknown } | undefined)?.type
    const message = typeof warning === "string" ? warning : warning.message
    if (type === "ExperimentalWarning" && message.startsWith("SQLite ")) return
    emitWarning(warning, ...rest)
  }) as EmitWarning
}
