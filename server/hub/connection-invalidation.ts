type DeviceConnectionInvalidationListener = (deviceId: string) => void

const listeners = new Set<DeviceConnectionInvalidationListener>()

/** Subscribe a long-lived hub transport to committed device connection changes. */
export function onDeviceConnectionsInvalidated(
  listener: DeviceConnectionInvalidationListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Close transports that were authorized and connected through an old record. */
export function invalidateDeviceConnections(deviceId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(deviceId)
    } catch {
      // One broken transport must not prevent the rest from being revoked.
    }
  }
}
