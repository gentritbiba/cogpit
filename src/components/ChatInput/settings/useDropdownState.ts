import { useCallback, useEffect, useRef, useState } from "react"

interface DropdownState {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  menuRef: React.RefObject<HTMLDivElement | null>
  menuPos: { top: number; left: number } | null
  closeAndFocus: () => void
}

export const MENU_OFFSET_STYLE = { transform: "translateY(-100%) translateY(-4px)" }

export function useDropdownState(): DropdownState {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const closeAndFocus = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setMenuPos({ top: rect.top, left: rect.left })
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleClick(event: MouseEvent) {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  useEffect(() => {
    if (!open || !menuPos) return

    const focusFirstItem = requestAnimationFrame(() => {
      const menu = menuRef.current
      const selected = menu?.querySelector<HTMLElement>(
        '[role^="menuitem"][aria-checked="true"]:not([disabled])',
      )
      const first = menu?.querySelector<HTMLElement>(
        '[role^="menuitem"]:not([disabled])',
      )
      ;(selected ?? first)?.focus()
    })

    function handleKeyDown(event: KeyboardEvent) {
      const menu = menuRef.current
      if (!menu) return
      const items = Array.from(
        menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
      )
      if (items.length === 0) return

      if (event.key === "Escape") {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (event.key === "Tab") {
        setOpen(false)
        return
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return

      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
      items[next]?.focus()
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFirstItem)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open, menuPos])

  return { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus }
}
