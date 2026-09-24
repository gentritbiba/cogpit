import { listenerSet } from "../lib/listenerSet"

// One broken transport must not prevent the rest from being revoked.
const invalidations = listenerSet<string>(() => {})

/** Subscribe a long-lived hub transport to committed device connection changes. */
export function onDeviceConnectionsInvalidated(
  listener: (deviceId: string) => void,
): () => void {
  return invalidations.add(listener)
}

/** Close transports that were authorized and connected through an old record. */
export function invalidateDeviceConnections(deviceId: string): void {
  invalidations.emit(deviceId)
}
