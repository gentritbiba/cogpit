/** The actual destination of a pending composer's accepted first prompt. */
export interface CreatedComposerSession {
  sessionId: string
  dirName: string
  cwd: string
}
export type ComposerCreated = (identity: CreatedComposerSession) => void
