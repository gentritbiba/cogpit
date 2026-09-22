# Cogpit plugin SDK

The SDK communicates through the MessagePort supplied by Cogpit's trusted runtime shell. It has no authenticated fetch function or access to the app's React tree.

Build a self-contained browser IIFE that sets exactly one activation function:

```ts
import { createPluginClient, type PluginClientOptions } from "@cogpit/plugin-sdk"

Object.assign(globalThis, {
  cogpitPlugin({ port, context }: PluginClientOptions) {
    const client = createPluginClient({ port, context })
    document.body.textContent = `Hello ${client.context.project?.name ?? "Cogpit"}`
    void client.ready()
  },
})
```

The trusted shell calls `globalThis.cogpitPlugin` once after loading the package. Call `ready()` after the panel mounts successfully. It sends one readiness request even when called repeatedly.

The client provides typed `connections.request`, `integrations.request`, `storage.get/set/delete`, `composer.append`, and `navigation.openExternal/openSession` methods. Composer calls append drafts. Session navigation accepts an opaque permitted handle. Provider operations accept declared IDs and typed arguments. Host policy decides whether each request is granted and available.

Calls accept an optional `{ signal }`. The SDK caps outstanding calls and message sizes, cancels timed-out requests, and discards late replies. Context replacement cancels outstanding calls. Subscribe through `onContextChange`, `onThemeChange` and `onVisibilityChange`; each returns an unsubscribe function. `dispose()` closes the port and rejects pending calls.

Optional capabilities use the same typed calls. Catch `PluginRequestError` with code `CAPABILITY_UNAVAILABLE` and render the package's fallback. Do not treat this as permission to invoke an undeclared operation or change the selected host.

Bundle the SDK and any UI framework into your IIFE. Do not import repository paths, host components or another plugin. Install the packed SDK/contracts into an external author directory when verifying a release build. No publication is needed for that local test.


GitHub, Vercel and Cloudflare operations use the selected host workspace. Declare specific operations under `permissions.integrations` and require `integrations.github`, `integrations.vercel` or `integrations.cloudflare` on the host. For example:

```ts
const result = await client.integrations.request({ integration: "github", operation: "pulls", limit: 20 })
if (result.ok) renderPulls(result.data)
else showSetupMessage(result.error.code)
```

The host permits only the fixed operations in the contracts. Workspace paths and CLI arguments are not request parameters. GitHub `pullSessions` returns opaque handles for `navigation.openSession`; storage addresses never enter the frame. Require `navigation.session` on the client when using session links. With the `session.identity` context permission, `client.context.session` carries the open chat session as the same kind of handle (or `null`), and `onContextChange` fires when it changes; compare it with `pullSessions` handles to recognise the current session. GitHub `mergePull` is the one write: it takes a pull request number, a merge method the repository allows and the full head SHA the plugin last displayed.
