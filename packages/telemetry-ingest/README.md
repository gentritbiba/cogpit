# telemetry-ingest

The Cloudflare Worker behind `telemetry.cogpit.dev`. Cogpit servers post their
[usage data](../../docs/telemetry.md) to `POST /v1/batch`; the Worker checks
every field, adds country, region, continent and timezone from Cloudflare's
`request.cf` (never the city or the IP address), keeps a raw copy in R2, and
forwards the batch to PostHog as anonymous events with PostHog's own IP lookup
off.

The app sends its own format, `{ installId, batch: [{ uuid, event, timestamp,
properties }] }`, so the analytics backend can change without an app release.
PostHog de-duplicates by `uuid`, so the app may safely resend a batch.

Answers: `200` accepted; `400`/`413` the batch is malformed; `422` PostHog
refused it (the app drops it); `503` try again later.

## Deploy

```bash
cd packages/telemetry-ingest
bunx wrangler@4 r2 bucket create cogpit-telemetry-archive   # once
bunx wrangler@4 secret put POSTHOG_API_KEY                   # the PostHog project's API key
bun run deploy
```

`wrangler.jsonc` binds the custom domain `telemetry.cogpit.dev` and sets
`POSTHOG_HOST`. Until `POSTHOG_API_KEY` is set, the Worker only archives each
batch to R2 and accepts it, so nothing sent before PostHog is set up is lost.
Without the R2 binding it forwards only.

Tests run with the root Vitest suite (`bun run test`), and
`bun run typecheck:telemetry-ingest` checks the Worker.
