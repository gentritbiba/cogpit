import { flushSync } from "react-dom"

export type ViewTransitionKind = "fade"

export interface ViewTransitionOptions {
  kind: ViewTransitionKind
}

const KIND_ATTRIBUTE = "data-view-transition-kind"
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

interface TransitionTag {
  root: HTMLElement
  kind: ViewTransitionKind
  previousKind: string | null
}

interface ActiveTransition {
  transition: ViewTransition
  tag: TransitionTag
}

let activeTransition: ActiveTransition | null = null
let activeTag: TransitionTag | null = null

function restoreAttribute(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    root.removeAttribute(name)
  } else {
    root.setAttribute(name, value)
  }
}

function applyTransitionTag(
  root: HTMLElement,
  kind: ViewTransitionKind,
): TransitionTag {
  const tag = {
    root,
    kind,
    previousKind: root.getAttribute(KIND_ATTRIBUTE),
  }

  root.setAttribute(KIND_ATTRIBUTE, kind)
  activeTag = tag

  return tag
}

function clearTransitionTag(tag: TransitionTag): void {
  if (activeTag !== tag) return

  if (tag.root.getAttribute(KIND_ATTRIBUTE) === tag.kind) {
    restoreAttribute(tag.root, KIND_ATTRIBUTE, tag.previousKind)
  }

  activeTag = null
}

function supersedeActiveTransition(): void {
  const current = activeTransition
  if (!current) return

  activeTransition = null
  try {
    current.transition.skipTransition()
  } catch {
    clearTransitionTag(current.tag)
    return
  }
  clearTransitionTag(current.tag)
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false

  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

export function runViewTransition(
  update: () => void,
  { kind }: ViewTransitionOptions,
): ViewTransition | null {
  supersedeActiveTransition()

  const transitionDocument = typeof document === "undefined" ? null : document
  const startViewTransition = transitionDocument?.startViewTransition

  if (!transitionDocument) {
    update()
    return null
  }

  const supportsNativeTransitions = typeof startViewTransition === "function"

  if (
    !supportsNativeTransitions
    || prefersReducedMotion()
  ) {
    update()
    return null
  }

  const tag = applyTransitionTag(transitionDocument.documentElement, kind)
  let didRunUpdate = false
  let didUpdateThrow = false
  let updateError: unknown

  const runUpdateOnce = (synchronously: boolean): void => {
    if (didRunUpdate) return
    didRunUpdate = true

    try {
      if (synchronously) {
        flushSync(update)
      } else {
        update()
      }
    } catch (error) {
      didUpdateThrow = true
      updateError = error
      throw error
    }
  }

  try {
    const transition = startViewTransition.call(transitionDocument, () => runUpdateOnce(true))
    const current = { transition, tag }
    activeTransition = current

    void transition.ready.catch(() => undefined)
    void transition.updateCallbackDone.catch(() => undefined)

    void transition.finished.then(
      () => {
        if (activeTransition === current) activeTransition = null
        clearTransitionTag(tag)
      },
      () => {
        if (activeTransition === current) activeTransition = null
        clearTransitionTag(tag)
      },
    )

    return transition
  } catch {
    clearTransitionTag(tag)
    if (didUpdateThrow) throw updateError

    runUpdateOnce(false)
    return null
  }
}
