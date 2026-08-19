# Self-hosting Cogpit

How to run Cogpit on a machine you are not sitting at, reach it from a browser or a phone,
and not get owned doing it.

If you just want the desktop app on your laptop, you do not need any of this. Download it
from [Releases](https://github.com/gentritbiba/cogpit/releases) and open it.

---

## What you need first

Cogpit drives the Claude Code and Codex CLIs. It does not replace them and it has no models
of its own.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or
  [Codex](https://github.com/openai/codex), installed and logged in on the machine that will
  run Cogpit.
- [Bun](https://bun.sh) if you are running from source.
- No API keys. Cogpit uses whatever login those CLIs already have.

The agents run on the box running Cogpit. Nothing is sent to a server of mine, because there
isn't one.

---

## The three ways to run it

| | What it is | Use when |
|---|---|---|
| Desktop app | Electron, macOS / Linux / Windows | You are at the machine |
| `bun run dev` | Vite dev server | You are hacking on Cogpit itself |
| `cogpit-server` | Headless, no Electron | The machine has no display, or you want it always on |

Only the third one needs this page.

---

## Headless server

```bash
git clone https://github.com/gentritbiba/cogpit.git
cd cogpit
bun install
bun run build

# Loopback only. Safe default, not reachable from the network.
bun server/standalone.ts
```

It prints the `host:port` it bound. Default is `127.0.0.1:19384`.

### Reachable from your network

It refuses to bind a non-loopback address without a password. That is deliberate.

```bash
COGPIT_HOST=0.0.0.0 \
COGPIT_NETWORK_PASSWORD='a genuinely long passphrase' \
bun server/standalone.ts
```

The password is read from the environment and never written to disk. Minimum 16 characters,
enforced. It is stored as a versioned scrypt hash using the OWASP profile.

If you would rather not put a secret in the environment directly, use a file. This works with
systemd `LoadCredential`:

```bash
COGPIT_NETWORK_PASSWORD_FILE=/run/credentials/cogpit/password bun server/standalone.ts
```

---

## Remote browser access needs HTTPS

This is the part people trip on, so it is worth being blunt about.

Cogpit keeps a browser session in a host-only, `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
A `Secure` cookie cannot be issued over plaintext HTTP. **So a plain `http://192.168.x.x:19384`
URL cannot log you in from a browser, by design.**

Put a TLS terminator in front of the loopback listener and open the HTTPS origin instead.

```caddyfile
cogpit.example.com {
    reverse_proxy 127.0.0.1:19384
}
```

```nginx
location / {
    proxy_pass http://127.0.0.1:19384;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;              # SSE will not stream without this
}
```

Two things to get right:

1. **Your proxy must send a forwarding header.** Either `Forwarded` or `X-Forwarded-For`. The
   standard Caddy and nginx proxy presets already do. Proxied traffic is then treated as
   remote and has to authenticate normally. If you strip every forwarding header *and* rewrite
   `Host` to `localhost`, the proxy hop becomes indistinguishable from a local client, and
   local clients skip auth.
2. **Turn off proxy buffering.** Cogpit streams sessions over SSE. Buffered output means the
   timeline sits still and then arrives in a lump.

A displayed `http://` LAN address stays usable for authenticated Cogpit hub and device
traffic. Do not open it as a browser login URL.

---

## Team edition

One Cogpit on a shared box, a login for each person using it. Personal edition — everything
else on this page — is unchanged and remains the default.

```bash
COGPIT_EDITION=team bun server/standalone.ts
```

Or set `"edition": "team"` in `config.local.json`. The environment variable wins when the
two disagree. Only the standalone server honors it: the desktop app and `bun run dev` always
run personal edition, and log that they suppressed the request instead of silently ignoring
it.

### First boot

With zero users the server prints a one-time setup URL. Its `#bootstrap=...` fragment carries
a random process-local credential; the browser removes that fragment from the address bar and
sends it in `X-Cogpit-Bootstrap-Token`. This prevents an arbitrary network client from winning
the founding-admin race. Filling in the page creates the first admin and signs you in. The
bootstrap is then closed for good — restarts do not reopen it, and a second attempt gets
`410 Already bootstrapped`. If the empty server restarts before setup, it prints a new token.

For a headless/curl bootstrap, set `COGPIT_BOOTSTRAP_TOKEN` (32–256 printable non-space ASCII characters) before
starting the empty server and send that value in `X-Cogpit-Bootstrap-Token`:

```bash
curl -X POST https://cogpit.example.com/api/team/bootstrap \
  -H 'Content-Type: application/json' \
  -H "X-Cogpit-Bootstrap-Token: $COGPIT_BOOTSTRAP_TOKEN" \
  -d '{"username":"admin","password":"a-long-unique-passphrase"}'
```

Browser logins, the bootstrap included, need HTTPS for the same `Secure`-cookie reason as
[above](#remote-browser-access-needs-https), so put the TLS proxy in front first and open
the server through it. Set `COGPIT_PUBLIC_URL` and the printed address is that URL rather
than the LAN one.

### Users

Admins manage accounts over the API. An admin UI is a later phase.

| Endpoint | Does |
|---|---|
| `POST /api/team/users` | Create: `{"username", "password", "role"}` |
| `GET /api/team/users` | List |
| `PATCH /api/team/users/:id` | Disable or enable, change role, set a new password |

Usernames are lowercase, 2–32 characters, `a-z0-9._-`. Passwords are minimum 16 characters,
the same rule as the network password. A patch that disables a user, changes their role, or
resets their password also revokes that user's live sessions on the spot. Logins survive
server restarts without resetting their 30-minute idle or eight-hour absolute expiry.

### Roles

Two. **admin** can do everything. **member** gets no terminal; no raw server/MCP config
inspection or editing; no config-path validation, command expansion, or checkpoint restore;
no device mutation, fleet kills, system process listing, caller-selected host filesystem, undo,
transcript-derived exact file changes, worktree mutation, or provider account/runtime usage APIs. Members can list devices and worktrees,
use the hub switcher, and start normal sessions with the worktree option. Codex goals and threads
remain ordinary session surfaces. Their sessions still inherit the MCP connectors configured by
an admin, but only admins can inspect connector definitions or use the selector. Provider plan,
credit balance, rate-limit, and aggregate usage metadata are likewise visible only to admins.

That is the honest extent of it today: members and admins see the same sessions. The role
gates cover the machine-access surfaces; workspaces, per-user visibility, sharing, and audit
come in later phases.

### The network password is ignored

User accounts replace it. In team edition `COGPIT_NETWORK_PASSWORD` does nothing — the boot
log says so if you set it — and the refuse-to-bind-without-a-password rule does not apply,
because logins are the authentication.

### As a hub device

A team server can be added as a device from a personal Cogpit. Enter the username and
password of the team account to connect as; everything done through the hub acts as that
user. Prefer a dedicated team account per hub over a person's own — the hub machine stores
that password, and a dedicated account can be rotated or disabled on its own.

### Security notes

- Local processes are **not** trusted in team edition. Everyone logs in, including clients
  on the machine itself.
- The terminal is admin-only, enforced server-side at the WebSocket upgrade. Established
  local and hub PTY connections — including Vite development PTYs — and authenticated live
  watch/task-output streams close when their login is revoked or expires.
- Raw config and MCP definition reads are admin-only because those files commonly contain
  bearer tokens, request headers, and command environment secrets.
- Changing `networkAccess` or the network password revokes **all** sessions, team logins
  included.
- Run the server as a dedicated OS user. Everything in
  [Security, stated plainly](#security-stated-plainly) applies double when several people
  share one box.

---

## Environment variables

Every one of these is read by the server. There are no others.

| Variable | Default | What it does |
|---|---|---|
| `COGPIT_HOST` | `127.0.0.1` | Bind address. Non-loopback requires a password. |
| `COGPIT_PORT` | `19384` | Bind port. |
| `COGPIT_DATA_DIR` | `~/.config/cogpit` | Where config lives. |
| `COGPIT_EDITION` | `personal` | Set `team` for [team edition](#team-edition). Standalone server only; wins over the config file. |
| `COGPIT_BOOTSTRAP_TOKEN` | random on each empty-store start | Optional one-time founding-admin token for headless/curl setup. 32–256 printable non-space ASCII characters; team edition only. |
| `COGPIT_NETWORK_PASSWORD` | none | Network password. Minimum 16 chars. Never written to disk. Ignored in team edition. |
| `COGPIT_NETWORK_PASSWORD_FILE` | none | Read the password from a file instead. |
| `COGPIT_DEVICE_NAME` | hostname | Label shown in the multi-device switcher. |
| `COGPIT_STREAM_PARTIAL` | on | Set `0`, `false`, `off` or `no` to disable token-level streaming. Completed session updates still arrive. |
| `COGPIT_NTFY_TOPIC` | none | ntfy topic for phone push. Push is off until set. |
| `COGPIT_NTFY_URL` | `https://ntfy.sh` | ntfy base URL. Self-hosted works. |
| `COGPIT_NTFY_TOKEN` | none | Sent as `Authorization: Bearer` for protected topics. |
| `COGPIT_PUBLIC_URL` | none | Reachable Cogpit base URL. Printed as the team-edition first-boot address; without it, pushes carry no click target instead of a dead `127.0.0.1` link. |

Env changes to the ntfy settings take effect without a restart.

---

## systemd unit

```ini
[Unit]
Description=Cogpit
After=network-online.target

[Service]
Type=simple
User=you
WorkingDirectory=/opt/cogpit
Environment=COGPIT_HOST=127.0.0.1
Environment=COGPIT_DEVICE_NAME=build-box
LoadCredential=password:/etc/cogpit/password
Environment=COGPIT_NETWORK_PASSWORD_FILE=%d/password
ExecStart=/usr/local/bin/bun server/standalone.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Binding loopback and letting Caddy terminate TLS in front is the arrangement I would pick.

---

## Phone push

Push only fires when nobody is at the desktop: no window open, screen locked or suspended, or
120 seconds with no keyboard or mouse input anywhere on the machine. That is system idle, not
window focus, so it will not go off while you are typing in another app.

Create `~/.cogpit/push.json` and `chmod 600` it. **The topic is a bearer secret. Anyone who
knows it can read every notification you get.**

```json
{ "topic": "some-long-unguessable-string", "publicUrl": "https://cogpit.example.com" }
```

Pick a topic like a password, not like a username. On a public ntfy server the topic is the
only thing standing between your session titles and the internet, so either make it long and
random or self-host ntfy.

---

## Multi-device hub

Register other machines and drive them from one window. Your browser only ever talks to the
hub, which reverse-proxies to each device, so there is nothing to configure per origin.

A device is addable if it runs either the desktop app with Network Access enabled, or
`cogpit-server`. Add one under **Devices → Add device** with its `host:port`, or
`https://host:port` if it sits behind a TLS proxy. A live probe tells you whether it is
reachable, needs a password, has network access disabled, or is running an older version.

`⌘⇧1` to `⌘⇧9` jump between devices, `⌘⇧0` cycles. Actions that only make sense on the
machine you are physically at, like open-in-editor and reveal-in-folder, are hidden while a
remote device is selected.

---

## Ports and discovery

The packaged app binds an ephemeral port unless Network Access pins one. It writes the bound
port to `~/.cogpit/port` on start and removes it on exit.

Anything integrating with a running Cogpit should resolve the port in this order:

1. `$COGPIT_PORT`
2. `~/.cogpit/port`
3. `19384`

---

## Security, stated plainly

What is actually there:

- Refuses to bind a non-loopback address without a password.
- Minimum 16 character password, versioned scrypt hash on the OWASP profile.
- Auth rate limited to 5 attempts per minute per client.
- Browser sessions expire after 30 minutes idle or 8 hours absolute, whichever comes first.
- Changing the password or disabling network access revokes every existing session.
- Password never written to disk when supplied by environment or credential file.
- No analytics, no account, no telemetry. It talks to localhost, to your CLIs, and to your
  ntfy topic if you configured one.

What is not there:

- **No security audit and no pentest.** This is one person's threat model.
- **No sandboxing of the agent.** Cogpit surfaces the CLI's own approval prompts and lets you
  pick a restrictive access profile, but it cannot sandbox what the CLI itself cannot. If
  isolation matters, run the agent in a container or a VM and use Cogpit to watch it.
- Credentials created by older releases that do not meet the current minimum must be reset
  from the local app.

**Do not expose this directly to the internet.** Put it behind Tailscale, a WireGuard tunnel,
or a Cloudflare tunnel with access control, and assume it is the weakest service on that
network. The bar it is built to is "reachable on my LAN," not "reachable from anywhere."

---

## Troubleshooting

**It exits immediately with a message about authentication.**
You set a non-loopback `COGPIT_HOST` without a password. Set `COGPIT_NETWORK_PASSWORD`, or
`COGPIT_NETWORK_PASSWORD_FILE`, or bind `127.0.0.1`.

**The login page loads over HTTP but the password never sticks.**
Expected. The session cookie is `Secure` and cannot be set over plaintext. Put TLS in front.

**The timeline freezes and then jumps.**
Proxy buffering. Set `proxy_buffering off` in nginx. Caddy does not buffer by default.

**Local requests are being asked for a password.**
Your proxy is not sending `Forwarded` or `X-Forwarded-For`, or something upstream rewrote the
`Host`. Add the standard proxy headers.

**Sessions started in a terminal do not show up.**
Cogpit reads the session files the CLIs write. Confirm the CLI on that machine is writing to
the home directory of the user running Cogpit.

**Push never arrives.**
`topic` must be set, and it is off until it is. Check `~/.cogpit/push.json` is valid JSON.
Remember push is suppressed entirely while you are active at the desktop.

---

Something wrong or missing here? [Open an issue](https://github.com/gentritbiba/cogpit/issues).
