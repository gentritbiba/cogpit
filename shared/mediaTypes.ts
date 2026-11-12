/**
 * Media the local-file route serves and the timeline renders inline, keyed by
 * lower-case extension. The Rust core uses the values as Content-Type and the
 * client uses the keys to decide what to render; both read `mediaTypes.json`.
 */
import mediaTypes from "./mediaTypes.json"

export const IMAGE_TYPES: Record<string, string> = mediaTypes.image

export const VIDEO_TYPES: Record<string, string> = mediaTypes.video
