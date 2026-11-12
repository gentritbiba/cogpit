import type { KeyboardEvent } from "react"

export function handleSearchKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return
  const input = event.currentTarget.querySelector<HTMLInputElement>('input[type="search"]')
  const target = event.target as HTMLElement
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-session-search-item]:not(:disabled)"))
  const index = items.indexOf(target as HTMLButtonElement)
  if (!items.length || (target !== input && index < 0)) return
  event.preventDefault()
  if (event.key === "Enter") {
    (index < 0 ? items[0] : items[index]).click()
    return
  }
  if (event.key === "ArrowUp" && index === 0) {
    input?.focus()
    return
  }
  const next = index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
    : Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))
  items[next].focus()
  items[next].scrollIntoView?.({ block: "nearest" })
}
