import type {
  ProviderUpdateId,
  ProviderUpdateInfo,
  ProviderUpdateRunResult,
  ProviderUpdatesResponse,
} from "../../shared/contracts/providerUpdates"
import { providerUpdateDismissKey } from "../../shared/contracts/providerUpdates"
import { authFetch } from "./auth"

export type {
  ProviderUpdateId,
  ProviderUpdateInfo,
  ProviderUpdateRunResult,
} from "../../shared/contracts/providerUpdates"
export { nextDismissals, providerUpdateDismissKey } from "../../shared/contracts/providerUpdates"

export const PROVIDER_UPDATE_DISMISSALS_KEY = "cogpit:provider-update-dismissals:v1"

/** Providers worth prompting about right now. */
export function pendingProviderUpdates(
  providers: readonly ProviderUpdateInfo[],
  dismissed: readonly string[],
): ProviderUpdateInfo[] {
  return providers.filter(
    (info) => info.status === "behind" && !dismissed.includes(providerUpdateDismissKey(info)),
  )
}

export async function fetchProviderUpdates(signal?: AbortSignal): Promise<ProviderUpdateInfo[]> {
  const response = await authFetch("/api/provider-updates", { signal })
  if (!response.ok) throw new Error(`Provider update check failed (${response.status})`)
  const data = (await response.json()) as Partial<ProviderUpdatesResponse>
  return data.providers ?? []
}

export async function runProviderUpdate(
  provider: ProviderUpdateId,
): Promise<ProviderUpdateRunResult> {
  const response = await authFetch("/api/provider-updates/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  })
  const data = (await response.json()) as Partial<ProviderUpdateRunResult> & { error?: string }
  if (!data.status) throw new Error(data.error ?? `Update failed (${response.status})`)
  return data as ProviderUpdateRunResult
}
