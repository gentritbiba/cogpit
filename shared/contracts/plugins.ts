import type { CompatibilityResult, ConnectionDefinition, PluginManifest } from "@cogpit/plugin-contracts"

export type PluginScope = { type: "all" } | { type: "projects"; projectIds: string[] }
export type PluginPublisherKind = "official" | "development"
export interface PluginPublisherSummary { id: string; label: string; kind: PluginPublisherKind; fingerprint: string; verifiedAt?: number }
export interface InstalledPluginVersion { digest: string; manifest: PluginManifest; targetPath: string; installedAt: number; unavailableReason?: string }
export interface InstalledPlugin {
  id: string
  selectedDigest: string
  manifest: PluginManifest
  enabled: boolean
  scope: PluginScope
  pinned: boolean
  versions: InstalledPluginVersion[]
  lastError?: string
}
export interface PluginStoreSnapshot {
  available: boolean
  error?: string
  revision: number
  plugins: InstalledPlugin[]
  publishers: PluginPublisherSummary[]
  legacyPluginIds?: string[]
  availableSeeds?: { manifest: PluginManifest; digest: string }[]
  recoveryCode?: "STORE_LOCKED" | "STORE_VERSION" | "STORE_CORRUPT" | "STORE_UNAVAILABLE"
}
export interface PluginInstallPreview {
  transactionId: string
  manifest: PluginManifest
  digest: string
  compatibility: CompatibilityResult
  oldVersion: string | null
  registryRevision: number
  publisherKind: PluginPublisherKind
  scope: PluginScope
  connectionDefinitions: ConnectionDefinition[]
  operation?: "install" | "update" | "rollback"
  previousManifest?: PluginManifest
  previousConnectionDefinitions?: ConnectionDefinition[]
  incompatibleClients?: string[]
}
