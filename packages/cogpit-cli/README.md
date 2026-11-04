# Cogpit

Run Cogpit locally without installing it:

```bash
npx cogpit@latest
```

The command starts Cogpit's backend on an available loopback port, opens the
full local web app, and keeps running until you press `Ctrl+C`. It also lists
which agent CLIs it found on this computer and how to install the others.

Cogpit reads session history from the Claude Code, Codex, and GitHub Copilot CLI
directories on your machine. It does not upload that history to a Cogpit cloud
service. Your agent CLI still sends requests to its model provider.

Open one session in the focused chat-only view:

```bash
npx cogpit@latest preview <session-id>
```

Both commands need [Node.js](https://nodejs.org) 22.16 or newer, and Claude
Code, Codex, or GitHub Copilot CLI installed and signed in. On Linux, also
install `python3`, `make` and `g++` first (for example
`sudo apt install python3 make g++`): the terminal component is compiled during
install.

Options:

```text
--port <number>  Bind a specific local port (default: automatic)
--data-dir <dir> Store Cogpit configuration in a specific directory
--server <url>   Open an already-running Cogpit server instead
--no-open        Start the server without opening a browser
```
