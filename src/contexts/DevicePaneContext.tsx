import { createContext, useContext } from "react"
import { deviceScopedKey, getActiveDeviceId, LOCAL_DEVICE_ID } from "@/lib/device"

/**
 * The machine a subtree belongs to. DeviceRoot keeps every recently visited
 * machine mounted, and a background pane still renders now and then, so code
 * that renders reads its machine here rather than from the URL, which names
 * only the active one. Effects and event handlers run only in the visible pane
 * and may keep using the URL helpers in lib/device.
 */
const DevicePaneContext = createContext<string | null>(null)

export const DevicePaneProvider = DevicePaneContext.Provider

export interface Machine {
  id: string
  name: string
}

/** Every machine this window can show, in swipe order. Empty outside DeviceRoot. */
const MachinesContext = createContext<readonly Machine[]>([])

export const MachinesProvider = MachinesContext.Provider

export function useMachines(): readonly Machine[] {
  return useContext(MachinesContext)
}

/** Ends when a machine's pane goes away for good, not when it is only hidden. */
export interface PaneLifetime {
  /** Run `callback` when the pane ends; returns a function that forgets it. */
  onEnd(callback: () => void): () => void
}

export function createPaneLifetime(): PaneLifetime & { end(): void } {
  const callbacks = new Set<() => void>()
  return {
    onEnd(callback) {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    end() {
      const ending = [...callbacks]
      callbacks.clear()
      for (const callback of ending) callback()
    },
  }
}

const PaneLifetimeContext = createContext<PaneLifetime | null>(null)

export const PaneLifetimeProvider = PaneLifetimeContext.Provider

/**
 * The lifetime of this subtree's machine pane, or null outside one. An effect
 * re-runs every time a hidden pane is shown again; a resource that should
 * outlive that (a worker holding parsed sessions) ends with the pane instead.
 */
export function usePaneLifetime(): PaneLifetime | null {
  return useContext(PaneLifetimeContext)
}

/** Whether this subtree is one of DeviceRoot's machine panes. */
export function useInDevicePane(): boolean {
  return useContext(DevicePaneContext) !== null
}

/** The machine this subtree shows; outside a pane, the active one. */
export function useDeviceId(): string {
  return useContext(DevicePaneContext) ?? getActiveDeviceId()
}

export function useIsRemoteDevice(): boolean {
  return useDeviceId() !== LOCAL_DEVICE_ID
}

/** {@link deviceScopedKey} for this subtree's machine. */
export function useDeviceScopedKey(base: string): string {
  return deviceScopedKey(base, useDeviceId())
}
