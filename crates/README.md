# Rust crates

`cogpit-core` is the Rust part of Cogpit's server: one program the TypeScript
server starts beside itself and talks to over loopback. It serves the terminals
and the file and git routes. Everything else is TypeScript.
[docs/architecture/rust-core.md](../docs/architecture/rust-core.md) explains
how the two fit together.

| Crate | What it is | TypeScript side |
| --- | --- | --- |
| [`cogpit-core`](cogpit-core) | The binary. Reads its secret and config from stdin, binds `127.0.0.1:0`, prints its port, rejects requests without the secret, mounts the feature crates (`src/routes/mod.rs`), exits when stdin closes. | `server/core/` starts, watches and stops it |
| [`core-protocol`](core-protocol) | The contract both sides read: `BootMessage`, `AppConfig`, `Handshake`, header names, protocol version. | `server/core/protocol.ts` |
| [`core-files`](core-files) | `local-file` (byte ranges), `file-content`, `project-files`, `project-file` (read and save), `git-status`, `git-diff`, under `/v1/files`. | `server/routes/core-files.ts` forwards each route |
| [`core-pty`](core-pty) | Terminal sessions (portable-pty on Unix, ConPTY on Windows), scrollback and the panel's WebSocket protocol, under `/v1/pty`. | `server/pty-socket.ts` relays `/__pty` |

A feature crate exposes `pub fn router(state) -> axum::Router`, owns no auth
(the TypeScript server authorized every request before forwarding it) and is
mounted with one line in `cogpit-core/src/routes/mod.rs`.

```bash
bun run build:core                     # debug build, what dev and tests use
bun run build:core --release --stage   # release build, staged in core-dist/ for packaging
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings && cargo test
```

`rust-toolchain.toml` pins the toolchain; install Rust from https://rustup.rs.
