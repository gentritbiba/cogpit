import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockFlushSync = vi.hoisted(() => vi.fn((update: () => void) => update()))

vi.mock("react-dom", () => ({ flushSync: mockFlushSync }))

import { runViewTransition } from "../viewTransitions"

interface MockTransitionController {
  transition: ViewTransition
  resolveFinished: () => void
}

const originalStartViewTransition = Object.getOwnPropertyDescriptor(document, "startViewTransition")
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia")
let transitionControllers: MockTransitionController[] = []

function createTransition(): MockTransitionController {
  let resolveFinished = (): void => undefined
  const finished = new Promise<undefined>((resolve) => {
    resolveFinished = () => resolve(undefined)
  })
  const controller = {
    transition: {
      finished,
      ready: Promise.resolve(undefined),
      updateCallbackDone: Promise.resolve(undefined),
      skipTransition: vi.fn(),
    },
    resolveFinished,
  }
  transitionControllers.push(controller)
  return controller
}

function installStartViewTransition(start: (update: () => void) => ViewTransition): void {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: start,
  })
}

function setReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches }) as MediaQueryList),
  })
}

function restoreProperty(
  target: Document | Window,
  name: "startViewTransition" | "matchMedia",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor)
  } else {
    Reflect.deleteProperty(target, name)
  }
}

beforeEach(() => {
  transitionControllers = []
  mockFlushSync.mockClear()
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: undefined,
  })
  setReducedMotion(false)
  document.documentElement.removeAttribute("data-view-transition-kind")
})

afterEach(async () => {
  for (const controller of transitionControllers) controller.resolveFinished()
  await Promise.resolve()

  restoreProperty(document, "startViewTransition", originalStartViewTransition)
  restoreProperty(window, "matchMedia", originalMatchMedia)
  document.documentElement.removeAttribute("data-view-transition-kind")
})

describe("runViewTransition", () => {
  it("updates immediately without forcing a synchronous React commit when unsupported", () => {
    const update = vi.fn()

    expect(runViewTransition(update, { kind: "fade" })).toBeNull()
    expect(update).toHaveBeenCalledOnce()
    expect(mockFlushSync).not.toHaveBeenCalled()
    expect(document.documentElement).not.toHaveAttribute("data-view-transition-kind")
  })

  it("skips the native transition when reduced motion is preferred", () => {
    const startViewTransition = vi.fn(() => createTransition().transition)
    installStartViewTransition(startViewTransition)
    setReducedMotion(true)
    const update = vi.fn()

    expect(runViewTransition(update, { kind: "fade" })).toBeNull()
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledOnce()
    expect(mockFlushSync).not.toHaveBeenCalled()
  })

  it("tags the document and flushes the update inside the native callback", async () => {
    const controller = createTransition()
    let nativeUpdate: (() => void) | undefined
    const startViewTransition = vi.fn((update: () => void) => {
      expect(document.documentElement).toHaveAttribute("data-view-transition-kind", "fade")
      nativeUpdate = update
      return controller.transition
    })
    installStartViewTransition(startViewTransition)
    const update = vi.fn()

    expect(runViewTransition(update, { kind: "fade" })).toBe(controller.transition)
    expect(update).not.toHaveBeenCalled()

    nativeUpdate?.()
    expect(mockFlushSync).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()

    controller.resolveFinished()
    await controller.transition.finished
    expect(document.documentElement).not.toHaveAttribute("data-view-transition-kind")
  })

  it("skips an active transition without allowing its cleanup to clear the next tag", async () => {
    const first = createTransition()
    const second = createTransition()
    const readyCatch = vi.spyOn(first.transition.ready, "catch")
    const updateCallbackDoneCatch = vi.spyOn(first.transition.updateCallbackDone, "catch")
    installStartViewTransition(vi.fn()
      .mockReturnValueOnce(first.transition)
      .mockReturnValueOnce(second.transition))

    runViewTransition(vi.fn(), { kind: "fade" })
    runViewTransition(vi.fn(), { kind: "panel-right" })

    expect(first.transition.skipTransition).toHaveBeenCalledOnce()
    expect(readyCatch).toHaveBeenCalledOnce()
    expect(updateCallbackDoneCatch).toHaveBeenCalledOnce()
    expect(document.documentElement).toHaveAttribute("data-view-transition-kind", "panel-right")

    first.resolveFinished()
    await first.transition.finished
    expect(document.documentElement).toHaveAttribute("data-view-transition-kind", "panel-right")

    second.resolveFinished()
    await second.transition.finished
    expect(document.documentElement).not.toHaveAttribute("data-view-transition-kind")
  })

  it("restores document tags that it temporarily replaced", async () => {
    document.documentElement.setAttribute("data-view-transition-kind", "external-kind")
    const controller = createTransition()
    installStartViewTransition(() => controller.transition)

    runViewTransition(vi.fn(), { kind: "panel-left" })
    controller.resolveFinished()
    await controller.transition.finished

    expect(document.documentElement).toHaveAttribute("data-view-transition-kind", "external-kind")
  })

  it("falls back exactly once when startViewTransition throws before its callback", () => {
    installStartViewTransition(() => {
      throw new Error("native transition failed")
    })
    const update = vi.fn()

    expect(runViewTransition(update, { kind: "fade" })).toBeNull()
    expect(update).toHaveBeenCalledOnce()
    expect(mockFlushSync).not.toHaveBeenCalled()
    expect(document.documentElement).not.toHaveAttribute("data-view-transition-kind")
  })

  it("does not repeat an update when startViewTransition throws after its callback", () => {
    installStartViewTransition((update) => {
      update()
      throw new Error("native transition failed late")
    })
    const update = vi.fn()

    expect(runViewTransition(update, { kind: "fade" })).toBeNull()
    expect(update).toHaveBeenCalledOnce()
    expect(mockFlushSync).toHaveBeenCalledOnce()
  })

  it("preserves an error thrown by the update callback", () => {
    const updateError = new Error("update failed")
    installStartViewTransition((update) => {
      update()
      throw new Error("native wrapper failed")
    })

    expect(() => runViewTransition(() => {
      throw updateError
    }, { kind: "fade" })).toThrow(updateError)
    expect(mockFlushSync).toHaveBeenCalledOnce()
  })
})
