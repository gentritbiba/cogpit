import { useSyncExternalStore } from "react"

export type ChatWidthId = "narrow" | "medium" | "wide" | "full"

interface ChatWidthDefinition {
  id: ChatWidthId
  name: string
  /** Value written to the --chat-width CSS variable. */
  css: string
}

export const chatWidths: ChatWidthDefinition[] = [
  { id: "narrow", name: "Narrow", css: "44rem" },
  { id: "medium", name: "Medium", css: "56rem" },
  { id: "wide", name: "Wide", css: "64rem" },
  { id: "full", name: "Full", css: "100%" },
]

const STORAGE_KEY = "cogpit-chat-width"
const DEFAULT_WIDTH: ChatWidthId = "medium"

function readStored(): ChatWidthId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (chatWidths.some((w) => w.id === stored)) return stored as ChatWidthId
  } catch { /* SSR / incognito fallback */ }
  return DEFAULT_WIDTH
}

let current: ChatWidthId = typeof window === "undefined" ? DEFAULT_WIDTH : readStored()
const listeners = new Set<() => void>()

function apply(id: ChatWidthId) {
  if (typeof document === "undefined") return
  const def = chatWidths.find((w) => w.id === id) ?? chatWidths[1]
  document.documentElement.style.setProperty("--chat-width", def.css)
}

apply(current)

export function getChatWidth(): ChatWidthId {
  return current
}

export function setChatWidth(id: ChatWidthId) {
  current = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch { /* incognito: apply for this session only */ }
  apply(id)
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Chat container width preference, shared across every component that reads it. */
export function useChatWidth(): [ChatWidthId, (id: ChatWidthId) => void] {
  const width = useSyncExternalStore(subscribe, getChatWidth, () => DEFAULT_WIDTH)
  return [width, setChatWidth]
}
