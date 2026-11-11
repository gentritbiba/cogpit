//! The media table in `shared/mediaTypes.json`, which the renderer reads too.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
struct MediaTypes {
    image: HashMap<String, String>,
    video: HashMap<String, String>,
}

static MEDIA_TYPES: LazyLock<MediaTypes> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../shared/mediaTypes.json"))
        .expect("shared/mediaTypes.json is valid")
});

/// The MIME type of an image extension (lower case, with its dot).
pub fn image_type(extension: &str) -> Option<&'static str> {
    MEDIA_TYPES.image.get(extension).map(String::as_str)
}

/// The MIME type of a video extension (lower case, with its dot).
pub fn video_type(extension: &str) -> Option<&'static str> {
    MEDIA_TYPES.video.get(extension).map(String::as_str)
}
