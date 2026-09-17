# Cogpit plugin contracts

Browser-safe schemas and protocol types shared by Cogpit and independently built plugins.
Import only from `@cogpit/plugin-contracts`. The package exports built JavaScript and TypeScript declarations.

`parseManifest`, `parseConnectionDefinition`, `parseFrameMessage` and `parsePluginContext` reject invalid input with `ContractValidationError`. Its `issues` contain paths and messages suitable for author diagnostics. `parseJson` validates structured JSON values, rejects accessors, cycles, unsupported objects and excessive size/depth, and copies accepted data. Raw JSON duplicate-key detection belongs to the archive reader before these functions are called.

`evaluateCompatibility(manifest, client, host, options)` returns compatibility issues and unavailable optional capabilities. API minor versions are additive within a supported major. The two descriptors describe the actual client and selected host. Declaring a capability does not implement or grant it.

Version 1 connection declarations support GET operations, one secret header, setup validation/list operations and selected resource slots. Provider execution and secret storage belong to the host. Signed publisher identity is verified separately from the manifest's publisher string.

Request, response and event envelopes use protocol major 1. Activation identity, authenticated sessions, grants and host leases never come from frame message fields.
