/**
 * Wire contract of the device-side /api/workspaces routes, which receive a
 * repository snapshot from a hub, check it out as a worktree, and hand the
 * result back as a git bundle.
 */

/** Largest body one PUT /api/workspaces/uploads/:uploadId may carry. */
export const WORKSPACE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
/** Largest bundle an upload may grow to. */
export const WORKSPACE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** Response header of GET /api/workspaces/downloads/:downloadId naming the ref inside the bundle. */
export const WORKSPACE_BUNDLE_REF_HEADER = "X-Cogpit-Bundle-Ref"

/** POST /api/workspaces/probe */
export interface WorkspaceProbeRequest {
  repoKey: string
}

export interface WorkspaceProbeResponse {
  /** Commits the device already has, for the sender to exclude from its bundle. */
  commits: string[]
}

/** POST /api/workspaces/uploads */
export interface WorkspaceUploadCreated {
  uploadId: string
}

/**
 * PUT /api/workspaces/uploads/:uploadId?offset=N — both the 200 and the 409
 * (offset does not match what the device holds) carry the bytes stored so far.
 */
export interface WorkspaceUploadProgress {
  size: number
}

/** POST /api/workspaces/import */
export interface WorkspaceImportRequest {
  repoKey: string
  /** Omit, with bundleRef, when probe showed the device already has `snapshot`. */
  uploadId?: string
  bundleRef?: string
  snapshot: string
  task: string
  /** posix path of the session cwd relative to the repository root, "" at the root. */
  subdir: string
  /** Makes a retried import return the workspace the first one made. */
  requestId?: string
}

export interface WorkspaceImportResponse {
  /** `<repoKey>/<task>` */
  workspaceId: string
  /** Worktree root on the device. */
  path: string
  /** Where a session should start: path + subdir. */
  cwd: string
  branch: string
}

/** POST /api/workspaces/remove — delete a workspace's worktree and branch. */
export interface WorkspaceRemoveRequest {
  workspaceId: string
}

/** POST /api/workspaces/export */
export interface WorkspaceExportRequest {
  workspaceId: string
  /** Commits the receiver already has. */
  exclude: string[]
}

export interface WorkspaceExportResponse {
  /** The workspace's HEAD, or a snapshot commit on top of it when it had uncommitted work. */
  tip: string
  dirty: boolean
  /** Fetch with GET /api/workspaces/downloads/:downloadId; null when the receiver already has tip. */
  downloadId: string | null
}
