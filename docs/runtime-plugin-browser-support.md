# Runtime plugin browser support

Verified 2026-09-15. Runtime plugins require a secure browser context and the APIs listed below. The core application can continue when the plugin gate rejects a browser, provided the browser can load the application bundle itself.

`src/plugins/browserSupport.ts` checks native API availability before the client starts polling, creates a plugin session, or sends a mutation. It checks secure context, MessageChannel/MessagePort, Blob URLs, Web Crypto digest/random values, AbortController, AbortSignal.any/timeout/throwIfAborted, structuredClone, Object.hasOwn, fetch, Headers, readable response streams, and text encoding/decoding. It does not allocate a channel, invoke crypto, make a request, inspect the user agent, or install global polyfills.

An unsupported browser receives a Plugins error naming the missing APIs. The client advertises no executable runtime or client capabilities. Its three manifest browser features remain truthful: a partial MessagePort API cannot advertise `message-channel`, missing Blob URL creation/revocation cannot advertise `blob-script`, and an insecure context cannot advertise `web-crypto`. Those three feature names remain the public manifest vocabulary; the complete client gate also checks the implementation's other prerequisites.

An active client that loses prerequisites aborts its work and clears its plugin state on refresh. It skips session-release requests if the required APIs are no longer usable; the host's expiring session and activation leases provide bounded cleanup. Normal stop/host-switch cleanup still sends DELETE to the captured host.

## Documented feature floors

These are compatibility-data floors, not results from running the application on those older browser versions.

| Requirement | Chrome / Chromium-based Edge | Firefox | Safari / iOS WebKit |
| --- | --- | --- | --- |
| AbortSignal.any | 116 | 124 | 17.4 |
| AbortSignal.timeout API | 103, with the exception-name caveat below | 100 | 16 |
| AbortSignal.throwIfAborted | 100 | 97 | 15.4 |
| structuredClone | 98 | 94 | 15.4 |
| Object.hasOwn | 93 | 92 | 15.4 |
| Tailwind CSS 4 supported baseline | 111 | 128 | 16.4 |
| Combined practical feature floor | **116** | **128** | **17.4** |

MDN records Chrome 103–123's timeout implementation as partial because it aborts with `AbortError` rather than `TimeoutError`. This runtime requires cancellation and does not distinguish those exception names. Chrome 124 provides the fully conforming timeout reason. These versions come from the primary [AbortSignal compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/AbortSignal.json), [structuredClone data](https://github.com/mdn/browser-compat-data/blob/main/api/_globals/structuredClone.json), and [Object.hasOwn data](https://github.com/mdn/browser-compat-data/blob/main/javascript/builtins/Object.json), checked against MDN BCD tree `483bb6cb636577da00fc0e3ed46372c88778d0cf`.

The standalone package builder targets ES2022 syntax. A syntax target does not supply missing Web APIs or JavaScript built-ins, so Object.hasOwn and structuredClone remain explicit prerequisites. The practical Firefox floor is 128 because the shared UI uses Tailwind 4, whose documented browser baseline is Chrome 111, Safari 16.4, and Firefox 128. See [Tailwind's compatibility policy](https://tailwindcss.com/docs/compatibility). The API gate is not a complete CSS compatibility test.

Use HTTPS for remote hosts. Browser-recognized trustworthy loopback origins such as localhost also qualify. An HTTP LAN address normally does not; the gate uses the browser's `isSecureContext` result rather than guessing from the hostname. See [MDN's secure context rules](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).

## Executed checks and platform limits

| Environment actually exercised | Evidence |
| --- | --- |
| Chrome for Testing 145.0.7632.6 on macOS | [Generated ClickUp package and trusted setup QA](../artifacts/runtime-plugins/clickup-runtime-qa.md) |
| Playwright WebKit 26.6, cached build 2359 on macOS | [Installed signed sample and browser API checks](../artifacts/runtime-plugins/webkit-runtime.md) |
| Electron 41.10.4, Chromium 146.0.7680.216, Node 24.18.0 on macOS | [Actual preload and frame navigation isolation](../artifacts/runtime-plugins/electron-navigation.md) |
| Browser gate/client/store focused tests on macOS | 92 tests passed, including missing APIs, insecure context, StrictMode, session descriptor requests, process ownership, and crash recovery |

These current-engine probes do not establish QA coverage for Chrome 116, Firefox 128, Safari 17.4, or physical iOS devices. There was no Windows host available for this local slice.

The existing `windows-latest` job in `.github/workflows/quality.yml` runs the application/server suite and public package contracts. Store process tests now include a portable external-process termination/recovery case and avoid SIGCONT in Windows cleanup. Only the pause/resume SIGSTOP test is POSIX-only. Node documents Windows process termination emulation for SIGKILL in [ChildProcess.kill](https://nodejs.org/api/child_process.html#subprocesskillsignal). The Windows CI lane must execute before claiming Windows verification; its presence is not a passing result.
