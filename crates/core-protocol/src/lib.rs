//! The contract between the TypeScript server and `cogpit-core`.
//!
//! Boot: the server spawns the binary and writes one JSON line ([`BootMessage`])
//! to its stdin. The core binds `127.0.0.1:0` and prints one JSON line
//! ([`Handshake`]) to stdout. Stdin then stays open for the core's lifetime:
//! when it closes, the core exits.
//!
//! Every request must carry [`SECRET_HEADER`]. [`PRINCIPAL_HEADER`] names the
//! caller TS already authorized; it is for logging only and grants nothing.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Header carrying the per-boot secret. Requests without it are rejected.
pub const SECRET_HEADER: &str = "x-cogpit-core-secret";

/// Header naming the principal TS authenticated. Informational only.
pub const PRINCIPAL_HEADER: &str = "x-cogpit-principal";

/// Bumped whenever the boot message, handshake or header contract changes
/// incompatibly, so the server refuses a stale binary instead of misbehaving.
pub const PROTOCOL_VERSION: u32 = 1;

/// Configuration the server passes to the core, and the core to feature crates.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// Cogpit's user-data directory (config, plugin state, caches).
    pub data_dir: PathBuf,
}

/// The single line the server writes to the core's stdin at spawn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootMessage {
    pub secret: String,
    pub config: AppConfig,
}

/// The single line the core prints to stdout once it is listening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub port: u16,
    pub version: String,
    pub protocol: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_message_uses_camel_case() {
        let boot: BootMessage =
            serde_json::from_str(r#"{"secret":"s","config":{"dataDir":"/tmp/x"}}"#).unwrap();
        assert_eq!(boot.secret, "s");
        assert_eq!(boot.config.data_dir, PathBuf::from("/tmp/x"));
    }

    #[test]
    fn handshake_serializes_as_one_object() {
        let line = serde_json::to_string(&Handshake {
            port: 4242,
            version: "0.1.0".into(),
            protocol: PROTOCOL_VERSION,
        })
        .unwrap();
        assert_eq!(line, r#"{"port":4242,"version":"0.1.0","protocol":1}"#);
    }
}
