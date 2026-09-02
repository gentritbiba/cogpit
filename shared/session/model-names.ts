const MODEL_FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"] as const

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * Human model name with its version ("Opus 4.8", "Fable 5.1 1M", "GPT-5.6 Sol")
 * from any model id or CLI alias. Unknown ids come back as-is, truncated.
 */
export function shortenModel(model: string): string {
  if (!model) return "unknown"
  const lower = model.toLowerCase()
  const context = /\[1m\]$/.test(lower) ? " 1M" : ""
  const id = lower.replace(/\[[^\]]*\]$/, "")

  for (const family of MODEL_FAMILIES) {
    const match = id.match(new RegExp(`${family}(?:-(\\d+)(?:-(\\d{1,2}))?(?!\\d))?`))
    if (!match) continue
    const version = match[1] ? ` ${match[1]}${match[2] ? `.${match[2]}` : ""}` : ""
    return `${capitalize(family)}${version}${context}`
  }

  if (id.startsWith("gpt-")) {
    const [version, ...rest] = id.slice(4).split("-")
    const suffix = rest.map(capitalize).join(" ")
    return `GPT-${version}${suffix ? ` ${suffix}` : ""}${context}`
  }

  return model.length > 20 ? model.slice(0, 20) + "..." : model
}
