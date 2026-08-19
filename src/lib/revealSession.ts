declare global {
  interface Window {
    /**
     * Registered by DeviceRoot once the router is mounted. The Electron main
     * process calls this (with retries) when a desktop notification is clicked,
     * instead of blindly injecting a pushState that a booting renderer would
     * drop. Its presence is the readiness ack.
     */
    __cogpitRevealSession?: (path: string) => void
  }
}

/**
 * Navigate the SPA to `path` through the history stack.
 *
 * Dispatching popstate makes both listeners react in their own domains:
 * DeviceRoot re-derives the device id (remounting App on a device change, whose
 * mount effect then loads the session from the URL), and useUrlSync loads the
 * session for an intra-device navigation.
 */
export function revealSessionPath(path: string): void {
  window.history.pushState({}, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}
