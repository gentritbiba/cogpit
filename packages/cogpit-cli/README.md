# Cogpit

Run Cogpit locally without installing it:

```bash
npx cogpit@latest
```

The command starts Cogpit's backend on an available loopback port, opens the
full local web app, and keeps running until you press `Ctrl+C`. Session data is
read directly from your existing Claude Code and Codex directories and is never
uploaded.

Open one session in the focused chat-only view:

```bash
npx cogpit@latest preview <session-id>
```

Both commands require Node.js 20.11 or newer and an authenticated Claude Code
or Codex CLI when you want to continue a session.

Options:

```text
--port <number>  Bind a specific local port (default: automatic)
--data-dir <dir> Store Cogpit configuration in a specific directory
--server <url>   Open an already-running Cogpit server instead
--no-open        Start the server without opening a browser
```
