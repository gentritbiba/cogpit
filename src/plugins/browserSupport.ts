export interface PluginBrowserEnvironment {
  isSecureContext?: unknown
  MessageChannel?: unknown
  MessagePort?: { prototype?: { postMessage?: unknown; start?: unknown; close?: unknown } } | null
  Blob?: unknown
  URL?: { createObjectURL?: unknown; revokeObjectURL?: unknown } | null
  crypto?: { subtle?: { digest?: unknown } | null; getRandomValues?: unknown } | null
  AbortController?: unknown
  AbortSignal?: { any?: unknown; timeout?: unknown; prototype?: { throwIfAborted?: unknown } } | null
  structuredClone?: unknown
  Object?: { hasOwn?: unknown } | null
  fetch?: unknown
  Headers?: unknown
  ReadableStream?: { prototype?: { getReader?: unknown } } | null
  TextEncoder?: unknown
  TextDecoder?: unknown
}

export interface PluginBrowserSupport {
  supported: boolean
  browser: Array<"message-channel" | "blob-script" | "web-crypto">
  missing: string[]
  error: string | null
}

export function getPluginBrowserSupport(environment: PluginBrowserEnvironment = globalThis): PluginBrowserSupport {
  const callable = (value: unknown): boolean => typeof value === "function"
  const channel = callable(environment.MessageChannel) && callable(environment.MessagePort?.prototype?.postMessage)
    && callable(environment.MessagePort?.prototype?.start) && callable(environment.MessagePort?.prototype?.close)
  const blob = callable(environment.Blob) && callable(environment.URL?.createObjectURL) && callable(environment.URL?.revokeObjectURL)
  const crypto = callable(environment.crypto?.subtle?.digest) && callable(environment.crypto?.getRandomValues)
  const secure = environment.isSecureContext === true
  const checks: Array<[string, boolean]> = [
    ["secure context (HTTPS or localhost)", secure],
    ["MessageChannel", channel], ["Blob URLs", blob], ["Web Crypto", crypto],
    ["AbortController", callable(environment.AbortController)],
    ["AbortSignal.any", callable(environment.AbortSignal?.any)],
    ["AbortSignal.timeout", callable(environment.AbortSignal?.timeout)],
    ["AbortSignal.throwIfAborted", callable(environment.AbortSignal?.prototype?.throwIfAborted)],
    ["structuredClone", callable(environment.structuredClone)],
    ["Object.hasOwn", callable(environment.Object?.hasOwn)],
    ["fetch", callable(environment.fetch)], ["Headers", callable(environment.Headers)],
    ["ReadableStream", callable(environment.ReadableStream?.prototype?.getReader)],
    ["TextEncoder", callable(environment.TextEncoder)], ["TextDecoder", callable(environment.TextDecoder)],
  ]
  const missing = checks.filter(([, available]) => !available).map(([name]) => name)
  const browser: PluginBrowserSupport["browser"] = []
  if (channel) browser.push("message-channel")
  if (blob) browser.push("blob-script")
  if (crypto && secure) browser.push("web-crypto")
  return {
    supported: missing.length === 0, browser, missing,
    error: missing.length ? `Runtime plugins are unavailable in this browser. Missing: ${missing.join(", ")}. Update your browser or use a secure connection.` : null,
  }
}
