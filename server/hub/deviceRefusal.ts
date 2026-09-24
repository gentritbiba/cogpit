import type { DeviceRefusal } from "../../shared/contracts/hub"
import { isRecord } from "../../shared/objects"

/**
 * Why a device answered `POST /api/auth/verify` with 403 for credentials it
 * checked: its own code and text, and whether it expects to let the account in
 * again without new credentials. Null when it names no code, as a personal
 * device with network access off does.
 */
export async function readDeviceRefusal(res: Response): Promise<DeviceRefusal | null> {
  const body: unknown = await res.json().catch(() => null)
  if (!isRecord(body) || typeof body.code !== "string" || !body.code) return null
  return {
    code: body.code,
    error: typeof body.error === "string" ? body.error : "",
    ...(body.retryable === true && { retryable: true }),
  }
}

/** The most device-supplied refusal text the hub relays. */
export const RELAYED_REFUSAL_MAX_CHARS = 300

/**
 * A device's refusal text as the hub relays it: bounded, since the device
 * writes it, and prefixed with the device's name, since the reader may not
 * know which device is speaking.
 */
export function relayedRefusalText(deviceName: string, text: string): string {
  const trimmed = text.trim()
  const bounded = trimmed.length > RELAYED_REFUSAL_MAX_CHARS
    ? `${trimmed.slice(0, RELAYED_REFUSAL_MAX_CHARS - 1).trimEnd()}…`
    : trimmed
  return `${deviceName}: ${bounded}`
}
