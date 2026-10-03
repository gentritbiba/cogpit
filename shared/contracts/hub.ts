/**
 * The hub's own verdicts (`X-Cogpit-Hub-Error`) on a device it could not get a
 * token from: the device refused its credentials, did not answer, or is not
 * admitting the account right now for a reason that can pass.
 */
export const MINT_FAILURE_CODES = ["DEVICE_AUTH_FAILED", "DEVICE_UNREACHABLE", "DEVICE_REFUSED"] as const
export type MintFailureCode = (typeof MINT_FAILURE_CODES)[number]

/**
 * A device's 403 on `POST /api/auth/verify` for credentials it checked: its
 * own code and text. `retryable` says the refusal can pass without the
 * credentials changing, so the hub keeps them and tries again.
 */
export interface DeviceRefusal {
  code: string
  error: string
  retryable?: true
}
