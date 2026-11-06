import type { ViewTheme } from "../../shared/views/frame"

/** What the frame kit (`VIEW_FRAME_KIT`) puts on `window.cogpit` before a view runs. */
export interface FrameApi {
  readonly theme: ViewTheme
  color(name: string): string
  onTheme(listener: (theme: ViewTheme) => void): () => void
  ask(text: string): void
}

export function frameApi(): FrameApi | undefined {
  return (window as { cogpit?: FrameApi }).cogpit
}
